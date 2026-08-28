'use strict';

const msgMgr = require('../message-manager');
const { isOwner, sendReact } = require('../utils');
const db = require('../db');
const appState = require('../../state');
const themeMgr = require('../theme-manager');
const config = require('../../config');
const axios = require('axios');
const os = require('os');

if (!global.settingsCache) {
    global.settingsCache = new Map();
}
const settingsCache = global.settingsCache;

async function checkIndividualAPI(service) {
    const start = Date.now();
    try {
        if (service === 'gemini' && config.GEMINI_API_KEY) {
            await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.GEMINI_API_KEY}`, { timeout: 2000 });
            return `✅ (${Date.now() - start}ms)`;
        }
        if (service === 'openrouter' && config.OPENROUTER_API_KEY) {
            await axios.get('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${config.OPENROUTER_API_KEY}` }, timeout: 2000 });
            return `✅ (${Date.now() - start}ms)`;
        }
        if (service === 'groq' && config.GROQ_API_KEY) {
            await axios.get('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${config.GROQ_API_KEY}` }, timeout: 2000 });
            return `✅ (${Date.now() - start}ms)`;
        }
    } catch { return '⚠️ Error'; }
    return '❌ Missing';
}

function getUptime() {
    const seconds = Math.floor(process.uptime());
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
}

function getSessionSettings(sessionId = '__main__') {
    if (sessionId !== '__main__') {
        const session = require('../../session-manager').get(sessionId);
        if (session) {
            return {
                autoRead: session.autoRead !== false,
                autoTyping: session.autoTyping !== false,
                autoReactStatus: session.autoReactStatus === true,
                nsfwEnabled: session.nsfwEnabled !== false,
                autoReply: session.autoReply !== false,
                aiAuto: session.aiAutoReply === true,
                aiVoice: session.aiAutoVoice === true,
                aiPersona: session.aiAutoPersona || 'friendly',
                aiLang: session.aiAutoLang || 'auto',
                aiGroupMode: session.aiGroupMode || 'mention',
                autoStatus: session.autoStatus !== false,
                botEnabled: session.botEnabled !== false,
                workMode: session.workMode || 'public',
                antiViewOnce: session.antiViewOnce === true,
                antiDelete: typeof session.antiDelete === 'object' ? session.antiDelete?.enabled === true : session.antiDelete === true,
                adTarget: session.antiDelete?.target || 'chat',
                alwaysOnline: session.alwaysOnline === true,
                antiCall: session.antiCall === true,
                buttonMode: session.buttonMode || appState.getButtonMode() || 'auto',
                roleMenuMode: session.roleMenuMode || appState.getRoleMenuMode() || 'strict'
            };
        }
    }
    return {
        autoRead: appState.getAutoRead() !== false,
        autoTyping: appState.getAutoTyping() !== false,
        autoReactStatus: appState.getAutoReactStatus() === true,
        nsfwEnabled: appState.getNsfwEnabled() !== false,
        autoReply: appState.getAutoReply() !== false,
        aiAuto: appState.getAiAutoReply() === true,
        aiVoice: appState.getAiAutoVoice() === true,
        aiPersona: appState.getAiAutoPersona() || 'friendly',
        aiLang: appState.getAiAutoLang() || 'auto',
        aiGroupMode: appState.getAiGroupMode() || 'mention',
        autoStatus: appState.getAutoStatus() !== false,
        botEnabled: appState.getBotEnabled() !== false,
        workMode: appState.getWorkMode() || 'public',
        antiViewOnce: appState.getAntiViewOnceEnabled() === true,
        antiDelete: (db.getSetting('main_bot_settings') || {}).antiDelete?.enabled === true,
        adTarget: (db.getSetting('main_bot_settings') || {}).antiDelete?.target || 'chat',
        alwaysOnline: (db.getSetting('main_bot_settings') || {}).alwaysOnline === true,
        antiCall: (db.getSetting('main_bot_settings') || {}).antiCall === true,
        buttonMode: appState.getButtonMode() || 'auto',
        roleMenuMode: appState.getRoleMenuMode() || 'strict'
    };
}

async function updateSessionSetting(sessionId, key, value) {
    if (sessionId !== '__main__') {
        const sessionMgr = require('../../session-manager');
        const res = await sessionMgr.updateSessionSettings(sessionId, { [key]: value });
        return !res.error;
    }
    const setters = {
        autoRead: appState.setAutoRead,
        autoTyping: appState.setAutoTyping,
        autoReactStatus: appState.setAutoReactStatus,
        nsfwEnabled: appState.setNsfwEnabled,
        autoReply: appState.setAutoReply,
        aiAuto: appState.setAiAutoReply,
        aiVoice: appState.setAiAutoVoice,
        aiPersona: appState.setAiAutoPersona,
        aiLang: appState.setAiAutoLang,
        aiGroupMode: appState.setAiGroupMode,
        autoStatus: (v) => { appState.setAutoStatus(v); db.setSetting('auto_view_status', v); },
        botEnabled: appState.setBotEnabled,
        workMode: appState.setWorkMode,
        antiViewOnce: appState.setAntiViewOnceEnabled,
        antiDelete: (v) => {
            const ov = db.getSetting('main_bot_settings') || {};
            if (!ov.antiDelete) ov.antiDelete = { enabled: false, target: 'chat', filters: { text: true, image: true, video: true } };
            ov.antiDelete.enabled = !!v;
            db.setSetting('main_bot_settings', ov);
        },
        adTarget: (v) => {
            const ov = db.getSetting('main_bot_settings') || {};
            if (!ov.antiDelete) ov.antiDelete = { enabled: false, target: 'chat', filters: { text: true, image: true, video: true } };
            ov.antiDelete.target = v;
            db.setSetting('main_bot_settings', ov);
        },
        alwaysOnline: (v) => {
            const ov = db.getSetting('main_bot_settings') || {};
            ov.alwaysOnline = !!v;
            db.setSetting('main_bot_settings', ov);
        },
        antiCall: (v) => {
            const ov = db.getSetting('main_bot_settings') || {};
            ov.antiCall = !!v;
            db.setSetting('main_bot_settings', ov);
        },
        buttonMode: (v) => { appState.setButtonMode(v); },
        roleMenuMode: (v) => { appState.setRoleMenuMode(v); }
    };
    if (setters[key]) {
        setters[key](value);
        return true;
    }
    return false;
}

const CATEGORIZED_SETTINGS = [
    {
        title: '🤖 CORE SYSTEM',
        items: [
            { label: 'Bot Status', key: 'botEnabled', type: 'bool', icon: '⚡' },
            { label: 'Always Online', key: 'alwaysOnline', type: 'bool', icon: '🔋' },
            { label: 'Anti-Call', key: 'antiCall', type: 'bool', icon: '📵' }
        ]
    },
    {
        title: '🧠 AI ENGINE',
        items: [
            { label: 'AI Auto-Reply', key: 'aiAuto', type: 'bool', icon: '🧠' },
            { label: 'AI Voice Mode', key: 'aiVoice', type: 'bool', icon: '🔊' },
            { label: 'AI Persona', key: 'aiPersona', type: 'cycle', options: ['friendly', 'funny', 'savage', 'romantic', 'professional', 'robot'], icon: '👤' },
            { label: 'AI Language', key: 'aiLang', type: 'cycle', options: ['auto', 'si', 'en'], icon: '🌐' },
            { label: 'Group AI Mode', key: 'aiGroupMode', type: 'cycle', options: ['mention', 'always'], icon: '👥' }
        ]
    },
    {
        title: '🛡️ PRIVACY & SECURITY',
        items: [
            { label: 'Anti-Delete', key: 'antiDelete', type: 'bool', icon: '🛡️' },
            { label: 'AD Target', key: 'adTarget', type: 'cycle', options: ['chat', 'owner'], icon: '🎯' },
            { label: 'Anti View-Once', key: 'antiViewOnce', type: 'bool', icon: '🕵️' },
            { label: 'NSFW Filter', key: 'nsfwEnabled', type: 'bool', icon: '🔞' }
        ]
    },
    {
        title: '⚙️ INTERACTION',
        items: [
            { label: 'Auto Status', key: 'autoStatus', type: 'bool', icon: '📺' },
            { label: 'Auto React', key: 'autoReactStatus', type: 'bool', icon: '🎭' },
            { label: 'Auto Read', key: 'autoRead', type: 'bool', icon: '📖' },
            { label: 'Auto Typing', key: 'autoTyping', type: 'bool', icon: '⌨️' },
            { label: 'Std Auto-Reply', key: 'autoReply', type: 'bool', icon: '📩' }
        ]
    },
    {
        title: '🎛️ UI MODE',
        items: [
            { label: 'Button Mode', key: 'buttonMode', type: 'cycle', options: ['auto', 'on', 'button', 'list', 'text', 'off'], icon: '🔘' },
            { label: 'Role Menu Mode', key: 'roleMenuMode', type: 'cycle', options: ['strict', 'relaxed', 'off'], icon: '🛡️' }
        ]
    }
];

const API_ACTIONS = [
    { label: 'Update Gemini', service: 'gemini', icon: '💎' },
    { label: 'Update OpenRouter', service: 'openrouter', icon: '🌍' },
    { label: 'Update Groq', service: 'groq', icon: '⚡' }
];

module.exports = [
    {
        name: 'settings',
        aliases: ['config', 'panel'],
        category: 'system',
        execute: async (sock, msg, from, args, cmdName, context) => {
            const sender = msg.key.participant || msg.key.remoteJid;
            const ownerRefs = context.owner ? [context.owner] : [];
            const tCtx = { sender, ownerRefs };

            if (!msg.key.fromMe && !isOwner(sender, ownerRefs)) return;

            await sendReact(sock, from, msg, "⏳");

            const start = Date.now();
            const [gemStatus, orStatus, groqStatus] = await Promise.all([
                checkIndividualAPI('gemini'),
                checkIndividualAPI('openrouter'),
                checkIndividualAPI('groq')
            ]);
            const ping = Date.now() - start;

            const sessionId = context.sessionId || '__main__';
            const settings = getSessionSettings(sessionId);
            const used = process.memoryUsage().heapUsed / 1024 / 1024;
            const prefix = context.prefix || '.';

            let response = themeMgr.format("header", { title: "CHATHU-MD PROFESSIONAL PANEL" }, tCtx);
            response += "\n";

            // System Health
            response += themeMgr.format("box_start", { title: "💻 SYSTEM STATUS" }, tCtx);
            response += themeMgr.format("box_item", { bullet: "default", content: `*Uptime:* ${getUptime()} | *Ping:* ${ping}ms` }, tCtx);
            response += themeMgr.format("box_item", { bullet: "default", content: `*RAM:* ${Math.round(used)}MB / ${Math.round(os.totalmem()/1024/1024)}MB` }, tCtx);
            response += themeMgr.format("box_end", {}, tCtx);
            response += "\n";

            // Settings Categories
            let globalCounter = 1;
            CATEGORIZED_SETTINGS.forEach(cat => {
                response += themeMgr.format("box_start", { title: cat.title }, tCtx);
                cat.items.forEach(s => {
                    let status = '';
                    if (s.type === 'bool') status = settings[s.key] ? '🟢 ON' : '🔴 OFF';
                    else if (s.type === 'cycle') status = `[ ${settings[s.key].toUpperCase()} ]`;

                    const emojiNum = globalCounter.toString().split('').map(d => d + '\u20E3').join('');
                    response += themeMgr.format("box_item", { 
                        bullet: "default", 
                        content: `${emojiNum} *${s.label}:* ${status}` 
                    }, tCtx);
                    globalCounter++;
                });
                response += themeMgr.format("box_end", {}, tCtx);
                response += "\n";
            });

            // API Actions
            response += themeMgr.format("box_start", { title: "🔐 API MANAGEMENT" }, tCtx);
            API_ACTIONS.forEach(s => {
                const emojiNum = globalCounter.toString().split('').map(d => d + '\u20E3').join('');
                response += themeMgr.format("box_item", { 
                    bullet: "default", 
                    content: `${emojiNum} *${s.label}:* ✎ EDIT` 
                }, tCtx);
                globalCounter++;
            });
            response += themeMgr.format("box_end", {}, tCtx);

            response += "\n" + themeMgr.format("box_start", { title: "💡 QUICK TIP" }, tCtx);
            response += themeMgr.format("box_item", { bullet: "default", content: "Reply with the number to toggle settings." }, tCtx);
            response += themeMgr.format("box_end", {}, tCtx);

            response += themeMgr.getSignature(sender, ownerRefs);

            const sent = await msgMgr.send(sock, from, { text: response }, { quoted: msg });
            settingsCache.set(sent.key.id, { sender, settings, prefix, sessionId });
            setTimeout(() => settingsCache.delete(sent.key.id), 300000);
            await sendReact(sock, from, msg, "🛡️");
        }
    },
    {
        name: 'setkey',
        category: 'system',
        execute: async (sock, msg, from, args, cmdName, context) => {
            const sender = msg.key.participant || msg.key.remoteJid;
            const ownerRefs = context.owner ? [context.owner] : [];
            if (!msg.key.fromMe && !isOwner(sender, ownerRefs)) return;

            const service = args[0]?.toLowerCase();
            const newKey = args[1];
            if (!service || !newKey) return await msgMgr.send(sock, from, { text: "⚠️ Usage: *.setkey <gemini/openrouter/groq> <key>*" });

            const fs = require('fs');
            const path = require('path');
            const envPath = path.join(process.cwd(), '.env');
            if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '');

            let envContent = fs.readFileSync(envPath, 'utf8');
            const envVar = service === 'gemini' ? 'GEMINI_API_KEY' :
                service === 'openrouter' ? 'OPENROUTER_API_KEY' :
                    service === 'groq' ? 'GROQ_API_KEY' : null;

            if (!envVar) return await msgMgr.send(sock, from, { text: "❌ Invalid service name." });

            const regex = new RegExp(`^${envVar}=.*`, 'm');
            if (envContent.match(regex)) envContent = envContent.replace(regex, `${envVar}=${newKey}`);
            else envContent += `\n${envVar}=${newKey}`;

            fs.writeFileSync(envPath, envContent.trim() + '\n');
            config[envVar] = newKey;
            process.env[envVar] = newKey;

            await msgMgr.send(sock, from, { text: `🚀 *${service.toUpperCase()} API KEY* has been successfully updated and secured.` });
            await sendReact(sock, from, msg, "✅");
        }
    },
    {
        name: 'handle_numeric_setting',
        internal: true,
        execute: async (sock, msg, from, num, quotedId, context) => {
            const cache = settingsCache.get(quotedId);
            if (!cache) return false;

            if (cache.type === 'selection') {
                const setting = cache.setting;
                const selectedOpt = setting.options[num - 1];
                if (!selectedOpt) return false;
                
                const success = await updateSessionSetting(cache.sessionId || '__main__', setting.key, selectedOpt);
                if (success) {
                    await msgMgr.send(sock, from, { text: `✨ *${setting.label}* set to: *${selectedOpt.toUpperCase()}*` }, { quoted: msg });
                    return true;
                }
                return false;
            }

            // Create flat list for mapping
            const FLAT_SETTINGS = [];
            CATEGORIZED_SETTINGS.forEach(cat => cat.items.forEach(item => FLAT_SETTINGS.push(item)));
            API_ACTIONS.forEach(act => FLAT_SETTINGS.push({ ...act, type: 'action' }));

            const idx = num - 1;
            const setting = FLAT_SETTINGS[idx];
            if (!setting) return false;

            if (setting.type === 'action') {
                const prefix = cache.prefix || '.';
                await msgMgr.send(sock, from, { text: `📝 *UPDATE ${setting.service.toUpperCase()} KEY*\n\nCopy the command below and add your new key:\n\n\`\`\`${prefix}setkey ${setting.service} \`\`\`` }, { quoted: msg });
                return true;
            }

            let newVal;
            if (setting.type === 'bool') {
                newVal = !cache.settings[setting.key];
            } else if (setting.type === 'cycle') {
                const sender = cache.sender;
                const ownerRefs = context.owner ? [context.owner] : [];
                const tCtx = { sender, ownerRefs };

                let optMsg = themeMgr.format("header", { title: `${setting.icon} ${setting.label.toUpperCase()}` }, tCtx);
                optMsg += "\n" + themeMgr.format("box_start", { title: "SELECT AN OPTION" }, tCtx);
                
                const DESCRIPTIONS = {
                    'friendly': 'හිතවත් මිතුරෙකු ලෙස',
                    'funny': 'විහිළු තහළු කරන මිතුරෙකු ලෙස',
                    'savage': 'ටිකක් Roast කරන, සැර මිතුරෙකු ලෙස',
                    'romantic': 'ආදරණීය මිතුරෙකු ලෙස',
                    'professional': 'වෘත්තීය සහයෙකු ලෙස',
                    'robot': 'තාක්ෂණික බොට් ලෙස',
                    'auto': 'ස්වයංක්‍රීයව (Auto)',
                    'si': 'සිංහල (Sinhala)',
                    'en': 'ඉංග්‍රීසි (English)',
                    'always': 'සෑම විටම',
                    'chat': 'මුල් Chat එකටම (Original Chat)',
                    'owner': 'මගේ Inbox එකට (Bot YOU Chat)'
                };

                setting.options.forEach((opt, i) => {
                    const isCurrent = cache.settings[setting.key] === opt;
                    const indicator = isCurrent ? ' (Active ✨)' : '';
                    const desc = DESCRIPTIONS[opt] ? `\n    └─ _${DESCRIPTIONS[opt]}_` : '';
                    const n = i + 1;
                    const emojiNum = n.toString().split('').map(d => d + '\u20E3').join('');
                    optMsg += themeMgr.format("box_item", { 
                        bullet: "default", 
                        content: `${emojiNum}  ➔  *${opt.toUpperCase()}*${indicator}${desc}` 
                    }, tCtx);
                });

                optMsg += themeMgr.format("box_end", {}, tCtx);
                optMsg += "\n" + themeMgr.format("box_item", { bullet: "default", content: "🔢 Reply with a number to activate." }, tCtx);
                optMsg += themeMgr.getSignature(sender, ownerRefs);
                
                const sent = await msgMgr.send(sock, from, { text: optMsg }, { quoted: msg });
                settingsCache.set(sent.key.id, { sender, setting, type: 'selection' });
                return true;
            }

            const success = await updateSessionSetting(cache.sessionId || '__main__', setting.key, newVal);

            if (success) {
                await msgMgr.send(sock, from, { text: `✨ *${setting.label}* updated to: *${String(newVal).toUpperCase()}*` }, { quoted: msg });
                return true;
            }
            return false;
        }
    },
    {
        name: 'theme',
        category: 'system',
        description: "Switch the bot's message theme (owner only)",
        execute: async (sock, msg, from, args, cmdName, context) => {
            const sender = msg.key.participant || msg.key.remoteJid;
            const ownerRefs = context.owner ? [context.owner] : [];
            if (!msg.key.fromMe && !isOwner(sender, ownerRefs)) {
                return msgMgr.sendTemp(sock, from, "🔒 Owner only.", 4000);
            }

            const arg = (args[0] || '').trim().toLowerCase();
            const all = themeMgr.getAvailableThemes();

            if (!arg || arg === 'list') {
                const current = db.getSetting('active_theme') || 'auto';
                let out = `🎨 *Available Themes* (current: *${current}*)\n\n`;
                all.forEach((t, i) => {
                    const tag = t.id === current ? ' ← active' : '';
                    out += `${i + 1}. ${t.emoji} *${t.id}* — ${t.name}${tag}\n`;
                });
                out += `\nUsage: \`${context.prefix || '.'}theme <id>\``;
                return msgMgr.send(sock, from, { text: out }, { quoted: msg });
            }

            if (!themeMgr.setTheme(arg)) {
                return msgMgr.sendTemp(
                    sock,
                    from,
                    `❌ Unknown theme \`${arg}\`. Use \`${context.prefix || '.'}theme list\` to see options.`,
                    6000,
                );
            }
            await sendReact(sock, from, msg, "🎨");
            await msgMgr.send(sock, from, { text: `✅ Theme switched to *${arg}*.` }, { quoted: msg });
        }
    },
    {
        name: 'mode',
        category: 'system',
        description: 'Switch bot work mode: public / private / self / group',
        execute: async (sock, msg, from, args, cmdName, context) => {
            const sender = msg.key.participant || msg.key.remoteJid;
            const ownerRefs = context.owner ? [context.owner] : [];
            if (!msg.key.fromMe && !isOwner(sender, ownerRefs)) {
                return msgMgr.sendTemp(sock, from, "🔒 Owner only.", 4000);
            }

            const allowed = ['public', 'private', 'self', 'group'];
            const arg = (args[0] || '').trim().toLowerCase();
            const current = appState.getWorkMode() || 'public';

            if (!arg) {
                return msgMgr.send(
                    sock,
                    from,
                    { text: `🛠️ *Current Mode:* \`${current}\`\n\nUsage: \`${context.prefix || '.'}mode <${allowed.join('|')}>\`` },
                    { quoted: msg },
                );
            }

            if (!allowed.includes(arg)) {
                return msgMgr.sendTemp(
                    sock,
                    from,
                    `❌ Unknown mode. Allowed: ${allowed.join(', ')}.`,
                    6000,
                );
            }

            await updateSessionSetting('workMode', arg);
            await sendReact(sock, from, msg, "✅");
            await msgMgr.send(sock, from, { text: `✨ Work mode set to *${arg.toUpperCase()}*.` }, { quoted: msg });
        }
    }
];
