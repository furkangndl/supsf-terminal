# Terminalo

VS Code benzeri workspace + [Claude Code](https://claude.com/claude-code) session yöneticisi. Terminal içinde (`supsf` komutu) veya macOS masaüstü uygulaması (Electron) olarak çalışır.

## Gereksinimler

- macOS (node-pty prebuild'leri ve masaüstü uygulaması macOS için)
- Node.js 22+ ve npm (geliştirme 22.x ile yapıldı)
- [Claude Code CLI](https://claude.com/claude-code) (`claude` komutu PATH'te olmalı)

## Kurulum

### Terminal sürümü

```sh
git clone https://github.com/furkangndl/supsf-terminal.git
cd supsf-terminal
npm install
npm link          # global `supsf` komutunu oluşturur
supsf [klasör]    # veya: npm start
```

### Masaüstü uygulaması (Terminalo.app)

```sh
cd supsf-terminal/desktop
npm install
npm run install-app   # paketler ve ~/Applications/Terminalo.app olarak kopyalar
```

Geliştirme modunda çalıştırmak için: `cd desktop && npm start`.

Not: uygulama, repo klasörünü `bin/supsf.js` dosyasından bulur. Repo başka yerdeyse `SUPSF_ROOT` ortam değişkenini repo yoluna ayarla.

## Config

`~/.config/supsf-terminal/config.json` — `workspaces`, `prefix`, `sidebarWidth`.

## Kısayollar (prefix: Ctrl+B)

| Tuş | İş |
|---|---|
| c / a | yeni shell / yeni Claude session |
| x | sekmeyi kapat (0 numaralı kalıcı shell sadece temizlenir) |
| n p 0-9 | sekme değiştir |
| e | kod split aç/kapat |
| s / b | sidebar odak / gizle |
| ← → | panel odağı |
| w | workspace ekle |
| PgUp PgDn | scrollback |
| q | çık |
| Ctrl+B Ctrl+B | Ctrl+B'yi terminale gönder |

Sidebar: ↑↓ Enter, `d` workspace sil, `r` yenile. Kod paneli: Tab ağaç/dosya, ↑↓, Enter.
Mouse: tıklama + scroll. Metin seçmek için Shift+sürükle (masaüstü uygulamasında doğrudan sürükle, Cmd+C ile kopyala).

## Geliştirme

```sh
npm run typecheck
```
