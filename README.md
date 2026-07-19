# 🤖 CannonFuryBot

Bot Telegram berbasis **Node.js** + **grammy** untuk menjadwalkan pesan (teks - gambar - video) ke banyak grup secara otomatis

## ✨ Fitur

- 🔒 Whitelist owner-only access
- 🗓️ Kelola jadwal: tambah, lihat, hapus
- 🖼️ Dukung teks, gambar + teks, video + teks
- 👥 Manajemen daftar grup target
- 🔁 Kirim otomatis tiap hari (`HH:mm`)
- 💾 Data tersimpan lokal

## 🛠️ Tech Stack

`Node.js v18+` · `grammy` · `node-cron` · `fs-extra` · `chalk`

## 🚀 Instalasi

```bash
git clone https://github.com/xdevcom/CannonFuryBot.git
cd CannonFuryBot
npm install
cp .env.example .env   # isi BOT_TOKEN & OWNER_ID
node index.js
```

## 📁 Struktur

```
schedule/
├── images/     {id}.jpg / {id}.mp4
├── captions/   {id}.txt
├── times/      {id}.json
└── groups.json
```
