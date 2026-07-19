require('dotenv').config({ override: true });
const { Bot, InlineKeyboard, session, InputFile, GrammyError } = require('grammy');
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
} = require('@xdevcom/bailmom');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const axios = require('axios');

// Get TZ from env immediately after loading dotenv
const TZ = process.env.TZ || 'Asia/Jakarta';
process.env.TZ = TZ;

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);

if (!BOT_TOKEN || !OWNER_ID) {
    console.error('BOT_TOKEN and OWNER_ID must be provided in .env');
    process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Folder structure setup
const DIRS = {
    base: path.join(__dirname, 'schedule'),
    images: path.join(__dirname, 'schedule', 'images'),
    captions: path.join(__dirname, 'schedule', 'captions'),
    times: path.join(__dirname, 'schedule', 'times'),
    groups: path.join(__dirname, 'schedule', 'groups.json'),
    settings: path.join(__dirname, 'schedule', 'settings.json'),
    whatsappAuth: path.join(__dirname, 'whatsapp_auth')
};

Object.values(DIRS).forEach(dir => {
    if (typeof dir === 'string' && !dir.endsWith('.json')) {
        fs.ensureDirSync(dir);
    }
});

if (!fs.existsSync(DIRS.groups)) fs.writeJsonSync(DIRS.groups, []);
if (!fs.existsSync(DIRS.settings)) fs.writeJsonSync(DIRS.settings, { pin: false, button: null });

// WhatsApp connection variables
let sock = null;
let isWAConnected = false;
let waPairingCode = null;
let waPhoneNumber = null;

async function connectToWhatsApp(ctx, phoneNumber = null) {
    const { state, saveCreds } = await useMultiFileAuthState(DIRS.whatsappAuth);
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting' && phoneNumber && !sock.authState.creds.registered) {
            await delay(1500);
            try {
                waPairingCode = await sock.requestPairingCode(phoneNumber);
                if (ctx) {
                    await updateMenu(ctx, `📞 Nomor : \`${phoneNumber}\`\n🔌 Pairing Code : \`${waPairingCode}\``, { reply_markup: backButton });
                }
            } catch (err) {
                // console.error('Failed to request pairing code:', err);
            }
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            isWAConnected = false;
            if (shouldReconnect) {
                connectToWhatsApp(ctx, phoneNumber);
            } else {
                if (ctx) await updateMenu(ctx, '❌ Koneksi WhatsApp terputus', { reply_markup: getMainMenu() });
            }
        } else if (connection === 'open') {
            isWAConnected = true;
            if (ctx) await updateMenu(ctx, '✅ WhatsApp berhasil terhubung', { reply_markup: getMainMenu() });
        }
    });

    return sock;
}

async function startWA(ctx) {
    if (fs.existsSync(DIRS.whatsappAuth) && fs.readdirSync(DIRS.whatsappAuth).length > 0) {
        await connectToWhatsApp(ctx);
    } else {
        await updateMenu(ctx, '📞 Kirimkan nomor WhatsApp anda', { reply_markup: backButton });
        ctx.session.state = 'waiting_for_whatsapp_number';
    }
}



// Session management
bot.use(session({
    initial: () => ({
        state: 'idle',
        activeScheduleId: null,
        mainMenuMessageId: null
    })
}));

// Whitelist middleware
bot.use(async (ctx, next) => {
    if (ctx.from && ctx.from.id === OWNER_ID) {
        return await next();
    }
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    }
});

// Utility functions
const generateScheduleId = () => {
    let id;
    do {
        id = Math.floor(10000 + Math.random() * 90000).toString();
    } while (fs.existsSync(path.join(DIRS.captions, `${id}.txt`)));
    return id;
};

// Console Splash Screen
const showSplashScreen = async () => {
    const files = await fs.readdir(DIRS.times);
    let totalChars = 0;
    for (const file of files) {
        try {
            const caption = await fs.readFile(path.join(DIRS.captions, `${file.replace('.json', '')}.txt`), 'utf-8');
            totalChars += caption.length;
        } catch (e) {}
    }

    console.clear();
    console.log(chalk.blue('📚 Loading context files from folder'));
    console.log(`Found ${files.length} file(s) to load...`);
    console.log(chalk.gray('\n──────────────────────────────────────────────────'));
    console.log(chalk.green(`✅ Context loaded successfully (${files.length} files, ${totalChars} total characters)`));
    console.log(chalk.gray('──────────────────────────────────────────────────'));
    console.log('\nUsing Baileys v2.3000.1039318300, isLatest: true');
    console.log(chalk.green('✅ Connect to Server'));
};

// Helper function to safely update menu
async function updateMenu(ctx, text, options = {}) {
    const messageId = ctx.session.mainMenuMessageId;
    const chatId = ctx.chat.id;

    try {
        if (options.media) {
            // Check if current message is already media or text to decide if we need to delete and resend
            // Grammy editMessageMedia can be tricky if switching from text to media
            await bot.api.editMessageMedia(chatId, messageId, options.media, { reply_markup: options.reply_markup });
        } else {
            await bot.api.editMessageText(chatId, messageId, text, { reply_markup: options.reply_markup, parse_mode: 'Markdown' });
        }
    } catch (err) {
        try { await bot.api.deleteMessage(chatId, messageId); } catch (e) {}
        let newMsg;
        if (options.media) {
            if (options.media.type === 'photo') {
                newMsg = await bot.api.sendPhoto(chatId, options.media.media, { caption: options.media.caption || text, reply_markup: options.reply_markup, parse_mode: 'Markdown' });
            } else if (options.media.type === 'video') {
                newMsg = await bot.api.sendVideo(chatId, options.media.media, { caption: options.media.caption || text, reply_markup: options.reply_markup, parse_mode: 'Markdown' });
            }
        } else {
            newMsg = await bot.api.sendMessage(chatId, text, { reply_markup: options.reply_markup, parse_mode: 'Markdown' });
        }
        if (newMsg) ctx.session.mainMenuMessageId = newMsg.message_id;
    }
}

// Keyboards
const getMainMenu = () => {
    return new InlineKeyboard()
        .text('💬 Set Schedule', 'set_schedule').row()
        .text('➕ Add Group', 'add_group').text('🗑 Del Schedule', 'del_schedule').row()
        .text('🗑 Del Group', 'del_group').text('🏷 List Schedule', 'list_schedule').row()
        .text('⚙️ Settings', 'settings').row()
        .text('🔌 Connect WhatsApp', 'connect_whatsapp');
};

const getSettingsMenu = () => {
    return new InlineKeyboard()
        .text('🔔 Sematkan', 'set_pin').text('🚥 Set Button', 'set_button').row()
        .text('🔙 Kembali', 'back_to_main');
};

const backButton = new InlineKeyboard().text('🔙 Kembali', 'back_to_main');

const jobRegistry = new Map();



const registerJob = (scheduleId, timeStr) => {
    const [hour, minute] = timeStr.split(":");
    const pattern = `${parseInt(minute)} ${parseInt(hour)} * * *`;
    
    if (jobRegistry.has(scheduleId)) jobRegistry.get(scheduleId).stop();

    const task = cron.schedule(pattern, async () => {
        try {
            const timeData = await fs.readJson(path.join(DIRS.times, `${scheduleId}.json`));
            const caption = await fs.readFile(path.join(DIRS.captions, `${scheduleId}.txt`), 'utf-8');
            const mediaFiles = await fs.readdir(DIRS.images);
            const mediaFile = mediaFiles.find(f => f.startsWith(scheduleId));
            const settings = await fs.readJson(DIRS.settings);
            
            const currentGroups = await fs.readJson(DIRS.groups);
            const telegramGroupIds = currentGroups.filter(g => g.type === 'telegram').map(g => g.id);
            const whatsappGroupIds = currentGroups.filter(g => g.type === 'whatsapp').map(g => g.id);

            for (const groupId of telegramGroupIds) {
                try {
                    let sentMsg;
                    const reply_markup = settings.button ? new InlineKeyboard().url(settings.button.text, settings.button.url) : undefined;
                    
                    if (mediaFile) {
                        const filePath = path.join(DIRS.images, mediaFile);
                        if (mediaFile.endsWith(".mp4")) {
                            sentMsg = await bot.api.sendVideo(groupId, new InputFile(filePath), { caption, reply_markup });
                        } else {
                            sentMsg = await bot.api.sendPhoto(groupId, new InputFile(filePath), { caption, reply_markup });
                        }
                    } else {
                        sentMsg = await bot.api.sendMessage(groupId, caption, { reply_markup });
                    }

                    if (settings.pin && sentMsg) {
                        try { await bot.api.pinChatMessage(groupId, sentMsg.message_id); } catch (e) {}
                    }
                } catch (err) {
                    console.error(`[Job] Failed to send schedule ${scheduleId} to Telegram group ${groupId}:`, err.message);
                }
            }

            for (const groupId of whatsappGroupIds) {
                if (!sock || !isWAConnected) {
                    console.error(`[Job] WhatsApp not connected`);
                    continue;
                }
                try {
                    let targetJid = groupId.toString().trim();
                    if (!targetJid.includes('@')) {
                        targetJid = targetJid.includes('-') ? `${targetJid}@g.us` : `${targetJid}@s.whatsapp.net`;
                    }
                    
                    // console.log(chalk.yellow(`[Job] Attempting to send to WhatsApp JID: ${targetJid}`));
                    
                    const settings = await fs.readJson(DIRS.settings);
                    
                    const fakeStatusQuoted = {
                        key: { remoteJid: 'status@broadcast', fromMe: false, participant: '0@s.whatsapp.net' },
                        message: { documentMessage: { fileName: 'Meta AI System', mimetype: 'application/pdf' } }
                    };

                    if (settings.button) {
                        // Using bailmom's nativeFlow support
                        const nativeFlow = [
                            {
                                text: settings.button.text,
                                url: settings.button.url
                            }
                        ];

                        const waMessage = {
                            caption: caption,
                            footer: '© Powered by WhatsApp',
                            nativeFlow: nativeFlow
                        };

                        if (mediaFile) {
                            const filePath = path.join(DIRS.images, mediaFile);
                            if (mediaFile.endsWith(".mp4")) {
                                waMessage.video = { url: filePath };
                            } else {
                                waMessage.image = { url: filePath };
                            }
                        }

                        await sock.sendMessage(targetJid, waMessage, { quoted: fakeStatusQuoted });
                    } else {
                        // Standard message if no button
                        const waContent = { text: caption };
                        if (mediaFile) {
                            const filePath = path.join(DIRS.images, mediaFile);
                            if (mediaFile.endsWith(".mp4")) {
                                waContent.video = { url: filePath };
                            } else {
                                waContent.image = { url: filePath };
                            }
                        }
                        await sock.sendMessage(targetJid, waContent, { quoted: fakeStatusQuoted });
                    }
                } catch (err) {
                    console.error(`[Job] Failed to send schedule ${scheduleId} to WhatsApp group ${groupId}:`, err.message);
                }
            }
            // Auto clear console after successful send
            await showSplashScreen();
        } catch (err) {
            console.error(`[Job] Execution error for ${scheduleId}:`, err.message);
        }
    }, { timezone: TZ });
    
    jobRegistry.set(scheduleId, task);
};

// Start Command
bot.command('start', async (ctx) => {
    const msg = await ctx.reply('Selamat datang di CannonFuryBot Panel', { reply_markup: getMainMenu() });
    ctx.session.mainMenuMessageId = msg.message_id;
    ctx.session.state = 'idle';
});

// Callback Handlers
bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const session = ctx.session;

    if (data === 'back_to_main') {
        session.state = 'idle';
        await updateMenu(ctx, 'Selamat datang di CannonFuryBot Panel', { reply_markup: getMainMenu() });
    } else if (data === 'settings' || data === 'back_to_settings') {
        session.state = 'idle';
        await updateMenu(ctx, '⚙️ Pengaturan pesan schedule', { reply_markup: getSettingsMenu() });
    } else if (data === 'set_pin') {
        const keyboard = new InlineKeyboard().text('✅ Iya', 'pin_yes').text('❌ Tidak', 'pin_no').row().text('🔙 Kembali', 'back_to_settings');
        await updateMenu(ctx, '🔔 Apakah pesan schedule yang di kirimkan ke group target akan di sematkan?', { reply_markup: keyboard });
    } else if (data === 'pin_yes' || data === 'pin_no') {
        const settings = await fs.readJson(DIRS.settings);
        settings.pin = data === 'pin_yes';
        await fs.writeJson(DIRS.settings, settings);
        await ctx.answerCallbackQuery({ text: `Sematkan: ${settings.pin ? 'Aktif' : 'Nonaktif'}` });
        await updateMenu(ctx, '⚙️ Pengaturan pesan schedule', { reply_markup: getSettingsMenu() });
    } else if (data === 'set_button') {
        const settings = await fs.readJson(DIRS.settings);
        if (settings.button) {
            const keyboard = new InlineKeyboard().text('✅ Iya', 'del_button_yes').text('❌ Tidak', 'del_button_no').row().text('🔙 Kembali', 'back_to_settings');
            await updateMenu(ctx, '❌ Anda sudah menyetting nya. Apakah anda ingin mengapusnya?', { reply_markup: keyboard });
        } else {
            session.state = 'waiting_for_button_format';
            await updateMenu(ctx, '🚥 Kirimkan format seperti contoh berikut:\n`🚀 Join Now - https://t.me/TurboAlliance/21`', { reply_markup: new InlineKeyboard().text('🔙 Kembali', 'back_to_settings') });
        }
    } else if (data === 'del_button_yes') {
        const settings = await fs.readJson(DIRS.settings);
        settings.button = null;
        await fs.writeJson(DIRS.settings, settings);
        await ctx.answerCallbackQuery({ text: 'Button dihapus' });
        await updateMenu(ctx, '⚙️ Pengaturan pesan schedule', { reply_markup: getSettingsMenu() });
    } else if (data === 'del_button_no') {
        await updateMenu(ctx, '⚙️ Pengaturan pesan schedule', { reply_markup: getSettingsMenu() });
    } else if (data === 'set_schedule') {
        session.state = 'waiting_for_schedule_content';
        await updateMenu(ctx, '💬 Kirimkan pesan schedule anda', { reply_markup: backButton });
    } else if (data === 'set_time') {
        session.state = 'waiting_for_schedule_time';
        await updateMenu(ctx, '🕘 Kirimkan waktu schedule pesan ini\nFormat: HH:mm, misal 17:00', { reply_markup: backButton });
    } else if (data === 'add_group') {
        session.state = 'waiting_for_group_type';
        const keyboard = new InlineKeyboard().text('🔔 Telegram', 'add_telegram_group').text('👥 WhatsApp', 'add_whatsapp_group').row().text('🔙 Kembali', 'back_to_main');
        await updateMenu(ctx, '🤔 Anda ingin menambahkan group apa?', { reply_markup: keyboard });
    } else if (data === 'add_telegram_group') {
        session.state = 'waiting_for_telegram_group_id';
        await updateMenu(ctx, '➕ Kirimkan ID group target', { reply_markup: backButton });
    } else if (data === 'add_whatsapp_group') {
        session.state = 'waiting_for_whatsapp_group_id';
        await updateMenu(ctx, '➕ Kirimkan ID group target', { reply_markup: backButton });
    } else if (data === 'del_schedule') {
        session.state = 'waiting_for_schedule_delete_id';
        await updateMenu(ctx, '🗑 Kirimkan ID pesan schedule anda', { reply_markup: backButton });
    } else if (data === 'del_group') {
        session.state = 'waiting_for_group_delete';
        await updateMenu(ctx, '🗑 Kirimkan ID group target', { reply_markup: backButton });
    } else if (data === 'list_schedule') {
        const files = await fs.readdir(DIRS.times);
        if (files.length === 0) {
            await updateMenu(ctx, '🏷 Belum ada pesan schedule', { reply_markup: backButton });
        } else {
            const keyboard = new InlineKeyboard();
            const schedules = [];
            for (const file of files) {
                const data = await fs.readJson(path.join(DIRS.times, file));
                schedules.push(data);
            }
            schedules.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            schedules.forEach((s, index) => {
                keyboard.text(`Pesan ${index + 1}`, `preview_${s.scheduleId}`).row();
            });
            keyboard.text('🔙 Kembali', 'back_to_main');
            await updateMenu(ctx, '🏷 Daftar pesan schedule anda', { reply_markup: keyboard });
        }
    } else if (data === 'connect_whatsapp') {
        if (isWAConnected) {
            const keyboard = new InlineKeyboard().text('✅ Iya', 'disconnect_whatsapp_yes').text('❌ Tidak', 'disconnect_whatsapp_no').row().text('🔙 Kembali', 'back_to_main');
            await updateMenu(ctx, '❌ Anda sudah menghubungkannya. Apakah anda ingin mengapusnya?', { reply_markup: keyboard });
        } else {
            // Initial state for connecting WhatsApp
            await updateMenu(ctx, '📞 Kirimkan nomor WhatsApp anda', { reply_markup: backButton });
            session.state = 'waiting_for_whatsapp_number';
        }
    } else if (data === 'disconnect_whatsapp_yes') {
        if (sock) {
            await sock.logout();
            isWAConnected = false;
            waPairingCode = null;
            waPhoneNumber = null;
            fs.removeSync(DIRS.whatsappAuth);
            await updateMenu(ctx, '✅ Sesi WhatsApp berhasil dihapus', { reply_markup: getMainMenu() });
        }
    } else if (data === 'disconnect_whatsapp_no') {
        await updateMenu(ctx, 'Selamat datang di CannonFuryBot Panel', { reply_markup: getMainMenu() });

    } else if (data.startsWith("preview_")) {
        const id = data.split('_')[1];
        const caption = await fs.readFile(path.join(DIRS.captions, `${id}.txt`), 'utf-8');
        const mediaFiles = await fs.readdir(DIRS.images);
        const mediaFile = mediaFiles.find(f => f.startsWith(id));
        const text = `📇 ID pesan : \`${id}\`\n\n${caption}`;
        const keyboard = new InlineKeyboard().text('🔙 Kembali', 'list_schedule');

        if (mediaFile) {
            const filePath = path.join(DIRS.images, mediaFile);
            const type = mediaFile.endsWith('.mp4') ? 'video' : 'photo';
            await updateMenu(ctx, text, { media: { type, media: new InputFile(filePath), caption: text, parse_mode: 'Markdown' }, reply_markup: keyboard });
        } else {
            await updateMenu(ctx, text, { reply_markup: keyboard });
        }
    }
    await ctx.answerCallbackQuery();
});

// Message Handlers
bot.on('message', async (ctx) => {
    const session = ctx.session;
    const state = session.state;
    
    // Auto-delete user message to keep chat clean
    if (state !== 'idle') {
        try { await ctx.deleteMessage(); } catch (e) {}
    }

    if (state === 'waiting_for_whatsapp_number') {
        const number = ctx.message.text.replace(/[^0-9]/g, '');
        if (!number) return await ctx.reply('Nomor tidak valid');
        waPhoneNumber = number;
        await updateMenu(ctx, '🔄 Sedang menghubungkan', { reply_markup: backButton });
        await connectToWhatsApp(ctx, number);
        session.state = 'idle';
    } else if (state === 'waiting_for_button_format') {
        const text = ctx.message.text;
        const parts = text.split(' - ');
        if (parts.length < 2) return await ctx.reply('Format `<button> - <link>` salah');
        
        const settings = await fs.readJson(DIRS.settings);
        settings.button = { text: parts[0], url: parts[1] };
        await fs.writeJson(DIRS.settings, settings);
        
        session.state = 'idle';
        await updateMenu(ctx, '🚥 Button di simpan', { reply_markup: getSettingsMenu() });

    } else if (state === 'waiting_for_schedule_content') {
        const scheduleId = generateScheduleId();
        let caption = ctx.message.text || ctx.message.caption || '';
        if (ctx.message.photo) {
            const file = await ctx.getFile();
            await downloadFile(file.file_path, path.join(DIRS.images, `${scheduleId}.jpg`));
        } else if (ctx.message.video) {
            const file = await ctx.getFile();
            await downloadFile(file.file_path, path.join(DIRS.images, `${scheduleId}.mp4`));
        } else if (!ctx.message.text) {
            return await ctx.reply('Format tidak didukung');
        }

        await fs.writeFile(path.join(DIRS.captions, `${scheduleId}.txt`), caption);
        session.activeScheduleId = scheduleId;
        session.state = 'schedule_content_saved';
        await updateMenu(ctx, '✅ Pesan schedule di simpan', { reply_markup: new InlineKeyboard().text('🕘 Set Time', 'set_time') });

    } else if (state === 'waiting_for_schedule_time') {
        const time = ctx.message.text;
        if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) return await ctx.reply('Format `HH:mm` salah');

        const groups = await fs.readJson(DIRS.groups);
        await fs.writeJson(path.join(DIRS.times, `${session.activeScheduleId}.json`), {
            scheduleId: session.activeScheduleId,
            time: time,
            groupIds: groups.map(g => g.id),
            createdAt: new Date().toISOString()
        });
        registerJob(session.activeScheduleId, time);
        session.state = 'idle';
        await updateMenu(ctx, '✅ Time schedule di simpan', { reply_markup: getMainMenu() });

    } else if (state === 'waiting_for_telegram_group_id') {
        try {
            const chat = await bot.api.getChat(ctx.message.text);
            const groups = await fs.readJson(DIRS.groups);
            if (!groups.find(g => g.id === chat.id)) {
                groups.push({ id: chat.id, username: chat.username || null, title: chat.title || 'Private Chat', type: 'telegram', addedAt: new Date().toISOString() });
                await fs.writeJson(DIRS.groups, groups);
            }
            session.state = 'idle';
            await updateMenu(ctx, '✅ Group target di tambahkan', { reply_markup: getMainMenu() });
        } catch (err) { await ctx.reply('Error: Group Telegram tidak ditemukan'); }
    } else if (state === 'waiting_for_whatsapp_group_id') {
        let whatsappGroupId = ctx.message.text.trim();
        if (!whatsappGroupId) return await ctx.reply('ID Group WhatsApp tidak valid');
        
        // Auto-fix common ID mistakes
        if (!whatsappGroupId.includes('@')) {
            whatsappGroupId = whatsappGroupId.includes('-') ? `${whatsappGroupId}@g.us` : `${whatsappGroupId}@s.whatsapp.net`;
        }

        const groups = await fs.readJson(DIRS.groups);
        if (!groups.find(g => g.id === whatsappGroupId)) {
            groups.push({ id: whatsappGroupId, title: 'WhatsApp Group', type: 'whatsapp', addedAt: new Date().toISOString() });
            await fs.writeJson(DIRS.groups, groups);
        }
        session.state = 'idle';
        await updateMenu(ctx, '✅ Group target di tambahkan', { reply_markup: getMainMenu() });

    } else if (state === 'waiting_for_schedule_delete_id') {
        const id = ctx.message.text;
        if (!fs.existsSync(path.join(DIRS.times, `${id}.json`))) return await ctx.reply('Group tidak ditemukan');
        await fs.remove(path.join(DIRS.times, `${id}.json`));
        await fs.remove(path.join(DIRS.captions, `${id}.txt`));
        const mediaFiles = await fs.readdir(DIRS.images);
        const mediaFile = mediaFiles.find(f => f.startsWith(id));
        if (mediaFile) await fs.remove(path.join(DIRS.images, mediaFile));
        if (jobRegistry.has(id)) { jobRegistry.get(id).stop(); jobRegistry.delete(id); }
        session.state = 'idle';
        await updateMenu(ctx, '✅ Pesan schedule di hapus', { reply_markup: getMainMenu() });

    } else if (state === 'waiting_for_group_delete') {
        const input = ctx.message.text;
        let groups = await fs.readJson(DIRS.groups);
        const index = groups.findIndex(g => g.id.toString() === input || g.username === input || (input.includes('t.me/') && input.endsWith(g.username)));
        if (index === -1) return await ctx.reply('Group tidak ditemukan');
        const removedGroup = groups[index];
        groups.splice(index, 1);
        await fs.writeJson(DIRS.groups, groups);
        
        // Remove group from schedules
        const scheduleFiles = await fs.readdir(DIRS.times);
        for (const file of scheduleFiles) {
            const data = await fs.readJson(path.join(DIRS.times, file));
            data.groupIds = data.groupIds.filter(id => id !== removedGroup.id);
            await fs.writeJson(path.join(DIRS.times, file), data);
        }
        session.state = 'idle';
        await updateMenu(ctx, '✅ Group target di hapus', { reply_markup: getMainMenu() });
    }
});

async function isJidBroadcast(jid) {
    return jid.endsWith('@broadcast');
}

async function downloadFile(filePath, dest) {
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await axios({ url, responseType: 'stream' });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

bot.catch((err) => {
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, err.error);
});

const init = async () => {
    const files = await fs.readdir(DIRS.times);
    for (const file of files) {
        const data = await fs.readJson(path.join(DIRS.times, file));
        registerJob(data.scheduleId, data.time);
    }
    await showSplashScreen();
    
    // Connect WhatsApp first if session exists
    if (fs.existsSync(DIRS.whatsappAuth) && fs.readdirSync(DIRS.whatsappAuth).length > 0) {
        await connectToWhatsApp(null);
    }

    bot.start();
};

// Initialize everything
init().catch(err => {
    console.error('Failed to initialize:', err);
});