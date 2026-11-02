# OrigamiVPN

Десктопный клиент OrigamiVPN - форк [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) (GPL-3.0).
Базовая версия: upstream v2.5.8 (`4337bd85`). Основная ветка форка: `origami`.

## Что меняем
Этап 0 - ребрендинг и собственная сборка, поведение пока стоковое:
- имя OrigamiVPN, идентификатор `pro.origamivpn.client`, своя папка конфигов, иконки приложения и трея (исходники в `branding/`);
- свои обновления: ключ подписи OrigamiVPN, адрес `releases/latest/download/latest.json` этого репозитория;
- схема ссылок `origamivpn://install-config?url=...` вместо `clash://`;
- User-Agent подписки `OrigamiVPN/<версия> (<ОС>)`: Mihomo-конфиг панель отдаёт по своему правилу «OrigamiVPN» (origami-infra `tools/panel/add-origamivpn-rule.py`); при запросе подписки клиент также шлёт `x-hwid`, `x-device-os`, `x-ver-os`, `x-device-model`;
- ссылки «Справка», «Канал», «GitHub» ведут на OrigamiVPN;
- установщик Windows не трогает автозапуск, ярлыки и ключи реестра оригинального Clash Verge;
- задачи автозапуска Windows называются `OrigamiVPN`.

## Принципы форка
- Минимум правок в стоковых файлах, чтобы обновления апстрима сливались без конфликтов.
- Бэкенд держим близко к апстриму, интерфейс меняем поверх существующих хуков и сервисов.
- Исходники открыты по условиям GPL-3.0.

## Обновление с апстрима
```bash
git remote add upstream https://github.com/clash-verge-rev/clash-verge-rev.git
git fetch upstream --tags
git merge v<версия>
pnpm i && pnpm typecheck && pnpm lint && pnpm test
```
Версии приложения (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) и `README.md` (страница OrigamiVPN, скриншоты в `docs/origami/`) остаются нашими.

### Слежение за апстримом
Workflow `origami-upstream-check` по понедельникам сверяет последние версии Mihomo и Clash Verge Rev с `.github/origami-upstream.json`. Если вышло новое, запуск завершается с ошибкой: GitHub присылает письмо «Run failed», в сводке запуска написано, что вышло.
- Новый Mihomo: код не трогаем, каждая сборка сама берёт последнее стабильное ядро (`scripts/prebuild.mjs`), достаточно выпустить новую версию.
- Новый Clash Verge Rev: слить тег апстрима по шагам выше, проверить наши изменения, выпустить версию.
После выпуска нашей версии с этими обновлениями поднимаем версии в `.github/origami-upstream.json`, и проверка снова зелёная.

## Сборка и релиз
Workflow `origami-build` собирает Windows x64 (NSIS) и Linux x64 (deb, rpm).
- Ручной запуск (Actions → OrigamiVPN build → Run workflow) - только артефакты.
- Тег `v*` - черновик релиза с установщиками и `latest.json`. Обновление приходит пользователям, когда черновик опубликован как обычный (не pre-release) релиз.

Секреты репозитория: `TAURI_PRIVATE_KEY`, `TAURI_KEY_PASSWORD` (ключ подписи обновлений).
