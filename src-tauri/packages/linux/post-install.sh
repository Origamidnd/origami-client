#!/bin/bash
chmod +x /usr/bin/clash-verge-service-install
chmod +x /usr/bin/clash-verge-service-uninstall
chmod +x /usr/bin/clash-verge-service

# OrigamiVPN connects in TUN mode, so the service is registered at install time. The installer needs
# the installing user's group for the service socket, known only under sudo or pkexec; otherwise the
# app installs the service on the first connection. Never fails the package installation.
if [ -n "${SUDO_UID:-}${PKEXEC_UID:-}" ]; then
    /usr/bin/clash-verge-service-install --install-service \
        --install-core /usr/bin/verge-mihomo --install-core /usr/bin/verge-mihomo-alpha \
        || echo "OrigamiVPN: the service will be installed on the first connection" >&2
fi
