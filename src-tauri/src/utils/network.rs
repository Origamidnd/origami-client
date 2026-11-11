use crate::config::MixedPort;
use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use reqwest::{
    Client, Proxy, StatusCode,
    header::{HeaderMap, HeaderValue, USER_AGENT},
};
use smartstring::alias::String;
use std::{sync::Arc, time::Duration};
use sysproxy::Sysproxy;
use tauri::Url;

#[derive(Debug)]
pub struct HttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl HttpResponse {
    const fn new(status: StatusCode, headers: HeaderMap, body: String) -> Self {
        Self { status, headers, body }
    }

    pub const fn status(&self) -> StatusCode {
        self.status
    }

    pub const fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    pub fn text(&self) -> &str {
        &self.body
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ProxyType {
    None,
    Localhost,
    System,
}

#[derive(Debug, Clone, Copy)]
enum TlsRootMode {
    PlatformVerifier,
    StaticWebpkiRoots,
}

pub struct NetworkManager {
    device_headers: bool,
}

impl NetworkManager {
    pub const fn new() -> Self {
        Self { device_headers: false }
    }

    /// Adds the device identity headers when the request goes to our subscription server
    /// ([`crate::utils::device::is_subscription_host`]); redirects then stay on that host.
    pub const fn with_device_headers(mut self) -> Self {
        self.device_headers = true;
        self
    }

    fn build_client(
        &self,
        proxy_url: Option<std::string::String>,
        default_headers: HeaderMap,
        accept_invalid_certs: bool,
        timeout_secs: Option<u64>,
        tls_root_mode: TlsRootMode,
        pinned_host: Option<std::string::String>,
    ) -> Result<Client> {
        let mut builder = Client::builder()
            .tls_backend_rustls()
            .redirect(Self::redirect_policy(pinned_host))
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(0)
            .pool_idle_timeout(None);

        if matches!(tls_root_mode, TlsRootMode::StaticWebpkiRoots) {
            builder = builder.tls_backend_preconfigured(Self::build_static_webpki_tls_config()?);
        }

        // 设置代理
        if let Some(proxy_str) = proxy_url {
            let proxy = Proxy::all(proxy_str)?;
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }

        builder = builder.default_headers(default_headers);

        // SSL/TLS
        if accept_invalid_certs {
            builder = builder
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true);
        }

        // 超时设置
        if let Some(secs) = timeout_secs {
            builder = builder
                .timeout(Duration::from_secs(secs))
                .connect_timeout(Duration::from_secs(secs.min(30)));
        }

        Ok(builder.build()?)
    }

    /// reqwest keeps custom headers across redirects, so with the device headers on, a redirect
    /// to another host is not followed: the 3xx comes back and the fetch fails instead.
    fn redirect_policy(pinned_host: Option<std::string::String>) -> reqwest::redirect::Policy {
        let Some(host) = pinned_host else {
            return reqwest::redirect::Policy::limited(10);
        };
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if attempt.url().host_str() == Some(host.as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        })
    }

    fn build_static_webpki_tls_config() -> Result<rustls::ClientConfig> {
        let root_store = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut config =
            rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()?
                .with_root_certificates(root_store)
                .with_no_client_auth();

        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

        Ok(config)
    }

    fn should_retry_with_static_webpki_roots(err: &anyhow::Error) -> bool {
        if err.chain().any(Self::is_legacy_tls_protocol_error) {
            return false;
        }

        err.chain().any(|e| {
            let msg = e.to_string().to_ascii_lowercase();
            [
                "certificate",
                "cert",
                "tls",
                "ssl",
                "rustls",
                "webpki",
                "revocation",
                "ocsp",
                "crl",
                "issuer",
                "unknownissuer",
            ]
            .iter()
            .any(|kw| msg.contains(kw))
        })
    }

    fn context_reqwest_error(err: reqwest::Error, context: &'static str) -> anyhow::Error {
        let legacy_tls = Self::is_legacy_tls_protocol_error(&err);
        let err = anyhow::Error::new(err).context(context);

        if legacy_tls {
            err.context("Subscription server uses legacy TLS; only TLS 1.2/1.3 is supported. TLS 1.0/1.1 is insecure")
        } else {
            err
        }
    }

    fn is_legacy_tls_protocol_error(err: &(dyn std::error::Error + 'static)) -> bool {
        let detail = format!("{err:#?}").to_ascii_lowercase();
        detail.contains("protocolversion") || detail.contains("protocol version")
    }

    async fn get_with_tls_mode(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
        tls_root_mode: TlsRootMode,
    ) -> Result<HttpResponse> {
        let mut parsed = Url::parse(url)?;
        let mut extra_headers = HeaderMap::new();

        if !parsed.username().is_empty() {
            let username = percent_encoding::percent_decode_str(parsed.username())
                .decode_utf8_lossy()
                .into_owned();
            let password = percent_encoding::percent_decode_str(parsed.password().unwrap_or_default())
                .decode_utf8_lossy()
                .into_owned();
            let auth_str = format!("{}:{}", username, password);
            let encoded = general_purpose::STANDARD.encode(auth_str);
            extra_headers.insert("Authorization", HeaderValue::from_str(&format!("Basic {}", encoded))?);
        }

        parsed.set_username("").ok();
        parsed.set_password(None).ok();

        let pinned_host = if self.device_headers && crate::utils::device::is_subscription_host(&parsed) {
            for (name, value) in crate::utils::device::device_headers() {
                extra_headers.insert(name, HeaderValue::from_str(&value)?);
            }
            parsed.host_str().map(str::to_owned)
        } else {
            None
        };

        // 创建请求
        let client = self
            .create_request_with_tls_mode(
                proxy_type,
                timeout_secs,
                user_agent,
                accept_invalid_certs,
                tls_root_mode,
                pinned_host,
            )
            .await?;

        let mut request_builder = client.get(parsed);

        for (key, value) in extra_headers.iter() {
            request_builder = request_builder.header(key, value);
        }

        let response = match request_builder.send().await {
            Ok(resp) => resp,
            Err(e) => {
                return Err(Self::context_reqwest_error(e, "Request failed"));
            }
        };

        let response: tauri::http::Response<reqwest::Body> = response.into();
        let response = reqwest::Response::from(
            response.map(|body| reqwest::Body::wrap(http_body_util::Limited::new(body, 4 * 1024 * 1024))),
        );

        let status = response.status();
        let headers = response.headers().to_owned();
        let body = match response.text().await {
            Ok(text) => text.into(),
            Err(e) => {
                return Err(Self::context_reqwest_error(e, "Failed to read response body"));
            }
        };

        Ok(HttpResponse::new(status, headers, body))
    }

    async fn create_request_with_tls_mode(
        &self,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
        tls_root_mode: TlsRootMode,
        pinned_host: Option<std::string::String>,
    ) -> Result<Client> {
        let proxy_url: Option<std::string::String> = match proxy_type {
            ProxyType::None => None,
            ProxyType::Localhost => {
                let port = MixedPort::desired().await;
                Some(format!("http://127.0.0.1:{port}"))
            }
            ProxyType::System => {
                if let Ok(p @ Sysproxy { enable: true, .. }) = Sysproxy::get_system_proxy() {
                    Some(format!("http://{}:{}", p.host, p.port))
                } else {
                    None
                }
            }
        };

        let mut headers = HeaderMap::new();

        // 设置 User-Agent
        if let Some(ua) = user_agent {
            headers.insert(USER_AGENT, HeaderValue::from_str(ua.as_str())?);
        } else {
            headers.insert(
                USER_AGENT,
                HeaderValue::from_str(&format!(
                    "OrigamiVPN/{} ({})",
                    env!("CARGO_PKG_VERSION"),
                    crate::utils::device::device_info().os
                ))?,
            );
        }

        self.build_client(
            proxy_url,
            headers,
            accept_invalid_certs,
            timeout_secs,
            tls_root_mode,
            pinned_host,
        )
    }

    pub async fn get(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
    ) -> Result<HttpResponse> {
        let platform_result = self
            .get_with_tls_mode(
                url,
                proxy_type,
                timeout_secs,
                user_agent.clone(),
                accept_invalid_certs,
                TlsRootMode::PlatformVerifier,
            )
            .await;

        match platform_result {
            Ok(response) => Ok(response),
            Err(err) if !accept_invalid_certs && Self::should_retry_with_static_webpki_roots(&err) => self
                .get_with_tls_mode(
                    url,
                    proxy_type,
                    timeout_secs,
                    user_agent,
                    accept_invalid_certs,
                    TlsRootMode::StaticWebpkiRoots,
                )
                .await
                .map_err(|fallback_err| {
                    fallback_err.context("static webpki roots fallback failed after platform TLS verifier failed")
                }),
            Err(err) => Err(err),
        }
    }

    async fn get_bytes_with_tls_mode(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        max_bytes: usize,
        tls_root_mode: TlsRootMode,
    ) -> Result<Vec<u8>> {
        let client = self
            .create_request_with_tls_mode(proxy_type, timeout_secs, None, false, tls_root_mode, None)
            .await?;

        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| Self::context_reqwest_error(e, "Request failed"))?;

        let status = response.status();
        if !status.is_success() {
            anyhow::bail!("request failed with status {status}");
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| Self::context_reqwest_error(e, "Failed to read response body"))?
        {
            if body.len() + chunk.len() > max_bytes {
                anyhow::bail!("response exceeded the {max_bytes} byte limit");
            }
            body.extend_from_slice(&chunk);
        }

        Ok(body)
    }

    /// Downloads a binary body, mirroring the TLS fallback of [`Self::get`].
    pub async fn get_bytes(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        max_bytes: usize,
    ) -> Result<Vec<u8>> {
        let platform_result = self
            .get_bytes_with_tls_mode(url, proxy_type, timeout_secs, max_bytes, TlsRootMode::PlatformVerifier)
            .await;

        match platform_result {
            Ok(body) => Ok(body),
            Err(err) if Self::should_retry_with_static_webpki_roots(&err) => self
                .get_bytes_with_tls_mode(url, proxy_type, timeout_secs, max_bytes, TlsRootMode::StaticWebpkiRoots)
                .await
                .map_err(|fallback_err| {
                    fallback_err.context("static webpki roots fallback failed after platform TLS verifier failed")
                }),
            Err(err) => Err(err),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "tests assert by panicking")]
mod device_header_tests {
    use super::{NetworkManager, ProxyType};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    /// Serves one request and returns its raw head, lowercased.
    async fn capture_one_request(listener: tokio::net::TcpListener) -> std::string::String {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut head = Vec::new();
        let mut buf = [0u8; 1024];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut buf).await.expect("read");
            if n == 0 {
                break;
            }
            head.extend_from_slice(&buf[..n]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .expect("write");
        std::string::String::from_utf8_lossy(&head).to_ascii_lowercase()
    }

    #[tokio::test]
    async fn device_identity_is_not_sent_to_another_subscription_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/AbCdEf1234567890", listener.local_addr().expect("addr"));
        let server = tokio::spawn(capture_one_request(listener));

        NetworkManager::new()
            .with_device_headers()
            .get(&url, ProxyType::None, Some(5), None, false)
            .await
            .expect("request");
        let head = server.await.expect("server");

        for header in ["x-hwid", "x-device-os", "x-ver-os", "x-device-model"] {
            assert!(!head.contains(header), "{header} sent to a foreign host");
        }
    }

    #[tokio::test]
    async fn pinned_client_does_not_follow_a_redirect_to_another_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(reply.as_bytes()).await.expect("write");
        });

        let client = NetworkManager::new()
            .build_client(
                None,
                reqwest::header::HeaderMap::new(),
                false,
                Some(5),
                super::TlsRootMode::PlatformVerifier,
                Some("127.0.0.1".to_owned()),
            )
            .expect("client");
        let response = client
            .get(format!("http://127.0.0.1:{port}/start"))
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
    }
}
