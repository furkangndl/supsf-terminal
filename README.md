# Terminalo

VS Code benzeri workspace + [Claude Code](https://claude.com/claude-code) session yöneticisi. Terminal içinde (`supsf` komutu) veya macOS masaüstü uygulaması (Electron) olarak çalışır.

## Gereksinimler

- macOS veya Windows 10/11 (x64 / arm64)
- Node.js 22+ ve npm (geliştirme macOS'ta 22.x ile yapıldı)
- [Claude Code CLI](https://claude.com/claude-code) (`claude` komutu PATH'te olmalı)
- Windows'ta: PowerShell (`powershell.exe`, Windows ile gelir). Sekmeler PowerShell açar.

> Windows desteği eklendi ama Windows'ta test edilmedi. Sorun bulursan issue aç.

## Kurulum

### Terminal sürümü (macOS / Windows)

```sh
git clone https://github.com/furkangndl/supsf-terminal.git
cd supsf-terminal
npm install
npm link          # global `supsf` komutunu oluşturur
supsf [klasör]    # veya: npm start
```

Windows'ta Windows Terminal kullanman önerilir (mouse, renk ve Unicode desteği için).

### Masaüstü uygulaması (Terminalo)

macOS:

```sh
cd supsf-terminal/desktop
npm install
npm run install-app   # paketler ve ~/Applications/Terminalo.app olarak kopyalar
```

Windows (PowerShell):

```powershell
cd supsf-terminal\desktop
npm install
npm run package:win   # dist\Terminalo-win32-x64\Terminalo.exe oluşur
```

Geliştirme modunda çalıştırmak için: `cd desktop && npm start`.

Not: uygulama, repo klasörünü `bin/supsf.js` dosyasından bulur (paketlerken repo yolu kaydedilir, repo'yu taşırsan yeniden paketle). Repo başka yerdeyse `SUPSF_ROOT` ortam değişkenini repo yoluna ayarla.

## Config

`~/.config/supsf-terminal/config.json` (Windows: `%USERPROFILE%\.config\supsf-terminal\config.json`) — `workspaces`, `prefix`, `sidebarWidth`.

## Kısayollar (prefix: Ctrl+B)

| Tuş | İş |
|---|---|
| c / a | yeni shell / yeni Claude session |
| x | sekmeyi kapat (0 numaralı kalıcı shell sadece temizlenir) |
| n p 0-9 | sekme değiştir |
| e | kod split aç/kapat |
| s / b | sidebar odak / gizle |
| ← → | panel odağı |
| r / , | sekmeyi yeniden adlandır (Claude sekmesinde session adını değiştirir) |
| w | workspace ekle |
| PgUp PgDn | scrollback |
| q | çık |
| Ctrl+B Ctrl+B | Ctrl+B'yi terminale gönder |

Sidebar: ↑↓ Enter, `n` session adlandır, `x` session sil, `u` geri getir, `d` workspace sil, `r` yenile. Kod paneli: Tab ağaç/dosya, ↑↓, Enter.
Mouse: tıklama + scroll. Terminal sürümünde metin seçmek için Shift+sürükle. Masaüstü uygulamasında doğrudan sürükle; kopyala/tümünü seç: macOS'ta Cmd+C / Cmd+A, Windows'ta Ctrl+Shift+C / Ctrl+Shift+A.

## Geliştirme

```sh
npm run typecheck
```
