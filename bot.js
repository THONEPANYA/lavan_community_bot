require('dotenv').config();
const {
    Client, GatewayIntentBits, ModalBuilder, TextInputBuilder,
    TextInputStyle, ActionRowBuilder, EmbedBuilder,
    ButtonBuilder, ButtonStyle, SlashCommandBuilder,
    PermissionFlagsBits, REST, Routes, ChannelType
} = require('discord.js');
const mysql = require('mysql2/promise');

// ── DB ───────────────────────────────────────────────
const db = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lavan_whitelist (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            discord_id   VARCHAR(32)   NOT NULL UNIQUE,
            discord_name VARCHAR(64)   NOT NULL,
            firstname    VARCHAR(64)   NOT NULL,
            lastname     VARCHAR(64)   NOT NULL,
            dob          DATE          NOT NULL,
            gender       ENUM('m','f') NOT NULL,
            height       SMALLINT      NOT NULL DEFAULT 170,
            reason       TEXT,
            status       ENUM('pending','approved','denied') DEFAULT 'approved',
            applied_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewed_at  TIMESTAMP NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lavan_bot_config (
            key_name   VARCHAR(64) PRIMARY KEY,
            value      VARCHAR(256)
        )
    `);
    console.log('✅ DB ready');
}

// ── Client ───────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

// ── Register slash commands ──────────────────────────
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-whitelist')
            .setDescription('[Admin] สร้างห้องลงทะเบียน Whitelist')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ตรวจสอบ')
            .setDescription('ตรวจสอบสถานะ Whitelist ของคุณ'),
        new SlashCommandBuilder()
            .setName('ถอน-whitelist')
            .setDescription('[Admin] ถอน Whitelist ของผู้เล่น')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addUserOption(o =>
                o.setName('ผู้ใช้').setDescription('เลือกผู้ใช้').setRequired(true)
            )
    ].map(c => c.toJSON());

    const rest = new REST().setToken(process.env.BOT_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
    );
    console.log('✅ Slash commands registered');
}

// ── ส่ง embed ปุ่มลงทะเบียนเข้าห้อง ─────────────────
async function sendRegisterEmbed(channel) {
    const embed = new EmbedBuilder()
        .setColor(0xC9A84C)
        .setTitle('⚔️  ยินดีต้อนรับสู่ Lavan Community')
        .setDescription(
            '```\nL A V A N   C O M M U N I T Y\n```\n' +
            '> **เซิร์ฟเวอร์ชุมชนที่สร้างขึ้นเพื่อทุกคน**\n' +
            '> แต่งตัว · พบปะ · เติบโตไปด้วยกัน\n\u200b'
        )
        .addFields(
            {
                name: '📋  วิธีลงทะเบียน',
                value:
                    '1️⃣  กดปุ่ม **📝 ลงทะเบียน** ด้านล่าง\n' +
                    '2️⃣  กรอกข้อมูลตัวละครในฟอร์มที่เด้งขึ้นมา\n' +
                    '3️⃣  รับ Role Whitelist **ทันที** โดยอัตโนมัติ\n' +
                    '4️⃣  เข้าเกมได้เลย ข้อมูลจะถูกกรอกอัตโนมัติ ✅',
                inline: false
            },
            {
                name: '📌  กฎก่อนสมัคร',
                value:
                    '• ห้าม RDM / VDM โดยไม่มีเหตุผล\n' +
                    '• เคารพซึ่งกันและกัน ไม่ด่าทอนอกเกม\n' +
                    '• ข้อมูลที่กรอกต้องเป็นชื่อตัวละคร ไม่ใช่ชื่อจริง',
                inline: false
            }
        )
        .setFooter({ text: 'Lavan Community · FiveM RP Server · ลงทะเบียนฟรี ไม่มีค่าใช้จ่าย' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('open_register')
            .setLabel('ลงทะเบียน')
            .setEmoji('📝')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('check_status')
            .setLabel('ตรวจสอบสถานะ')
            .setEmoji('🔍')
            .setStyle(ButtonStyle.Secondary)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    await db.execute(
        'INSERT INTO lavan_bot_config (key_name, value) VALUES ("register_msg_id",?) ON DUPLICATE KEY UPDATE value=?',
        [msg.id, msg.id]
    );
    return msg;
}

// ════════════════════════════════════════════════════
//  Interaction handler
// ════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {

    // ── /setup-whitelist ─────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-whitelist') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;

        // ลบห้องเก่าถ้ามี
        const oldCh = guild.channels.cache.find(c => c.name === '📋︱ลงทะเบียน');
        if (oldCh) await oldCh.delete().catch(() => {});

        // category
        let cat = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name === 'LAVAN COMMUNITY'
        );
        if (!cat) {
            cat = await guild.channels.create({
                name: 'LAVAN COMMUNITY',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }
                ]
            });
        }

        // ห้องลงทะเบียน
        const regCh = await guild.channels.create({
            name: '📋︱ลงทะเบียน',
            type: ChannelType.GuildText,
            parent: cat.id,
            topic: 'กดปุ่มเพื่อลงทะเบียน Whitelist และเข้าร่วม Lavan Community',
            permissionOverwrites: [
                {
                    id: guild.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: client.user.id,
                    allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages]
                }
            ]
        });

        // ห้อง log (Staff เห็นคนเดียว)
        let logCh = guild.channels.cache.find(c => c.name === '📜︱whitelist-log');
        if (!logCh) {
            logCh = await guild.channels.create({
                name: '📜︱whitelist-log',
                type: ChannelType.GuildText,
                parent: cat.id,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    {
                        id: process.env.STAFF_ROLE_ID,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages]
                    },
                    { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
                ]
            });
        }

        await db.execute(
            'INSERT INTO lavan_bot_config (key_name,value) VALUES ("log_channel_id",?) ON DUPLICATE KEY UPDATE value=?',
            [logCh.id, logCh.id]
        );

        await sendRegisterEmbed(regCh);
        await interaction.editReply(`✅ สร้างห้อง ${regCh} สำเร็จแล้วครับ!`);
    }

    // ── Button: open_register ────────────────────────
    if (interaction.isButton() && interaction.customId === 'open_register') {
        const [rows] = await db.execute(
            'SELECT status FROM lavan_whitelist WHERE discord_id=?',
            [interaction.user.id]
        );
        if (rows.length) {
            return interaction.reply({
                content: rows[0].status === 'approved'
                    ? '✅ คุณมี Whitelist อยู่แล้วครับ เข้าเกมได้เลย!'
                    : '❌ สถานะของคุณถูกระงับ กรุณาติดต่อ Staff',
                ephemeral: true
            });
        }

        // แสดง Modal
        const modal = new ModalBuilder()
            .setCustomId('wl_modal')
            .setTitle('📝 ลงทะเบียน Whitelist — Lavan Community');

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('firstname')
                    .setLabel('ชื่อตัวละคร (ไทย / อังกฤษ)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('เช่น สมชาย หรือ Somchai')
                    .setMinLength(2).setMaxLength(32).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('lastname')
                    .setLabel('นามสกุลตัวละคร')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('เช่น ใจดี หรือ Jaidee')
                    .setMinLength(2).setMaxLength(32).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('dob')
                    .setLabel('วันเกิดตัวละคร (YYYY-MM-DD)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('เช่น 1990-05-20')
                    .setMinLength(10).setMaxLength(10).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('gender')
                    .setLabel('เพศ — เลือก 1 ตัวเลือก')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('m = ชาย  |  f = หญิง  |  lg = LGBTQ+')
                    .setMinLength(1).setMaxLength(2).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('height')
                    .setLabel('ส่วนสูง (ซม.) เช่น 175')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('ระหว่าง 140 - 220')
                    .setMinLength(3).setMaxLength(3).setRequired(true)
            )
        );

        await interaction.showModal(modal);
    }

    // ── Button: check_status ─────────────────────────
    if (interaction.isButton() && interaction.customId === 'check_status') {
        const [rows] = await db.execute(
            'SELECT * FROM lavan_whitelist WHERE discord_id=?', [interaction.user.id]
        );
        if (!rows.length) {
            return interaction.reply({ content: '❓ คุณยังไม่ได้ลงทะเบียน กดปุ่ม **📝 ลงทะเบียน** ได้เลยครับ', ephemeral: true });
        }
        const r = rows[0];
        const embed = new EmbedBuilder()
            .setColor(r.status === 'approved' ? 0x22c55e : 0xef4444)
            .setTitle('📋 สถานะ Whitelist ของคุณ')
            .setThumbnail(interaction.user.displayAvatarURL())
            .addFields(
                { name: 'สถานะ',      value: r.status === 'approved' ? '✅ Whitelisted' : '❌ ถูกระงับ', inline: true },
                { name: 'ตัวละคร',   value: `${r.firstname} ${r.lastname}`,                              inline: true },
                { name: 'ลงทะเบียน', value: new Date(r.applied_at).toLocaleDateString('th-TH'),         inline: true }
            )
            .setFooter({ text: 'Lavan Community' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── Modal submit ─────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'wl_modal') {
        await interaction.deferReply({ ephemeral: true });

        const firstname     = interaction.fields.getTextInputValue('firstname').trim();
        const lastname      = interaction.fields.getTextInputValue('lastname').trim();
        const dob           = interaction.fields.getTextInputValue('dob').trim();
        const gender        = interaction.fields.getTextInputValue('gender').trim().toLowerCase();
        const height        = parseInt(interaction.fields.getTextInputValue('height').trim()) || 170;
        const reason        = '';

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            return interaction.editReply('❌ รูปแบบวันเกิดไม่ถูก ใช้ YYYY-MM-DD เช่น 1990-05-20');
        }
        if (!['m', 'f', 'lg'].includes(gender)) {
            return interaction.editReply('❌ เพศต้องเป็น **m** (ชาย), **f** (หญิง) หรือ **lg** (LGBTQ+) เท่านั้น');
        }
        if (height < 140 || height > 220) {
            return interaction.editReply('❌ ส่วนสูงต้องอยู่ระหว่าง 140–220 ซม.');
        }

        // บันทึก DB
        try {
            await db.execute(
                `INSERT INTO lavan_whitelist
                 (discord_id, discord_name, firstname, lastname, dob, gender, height, reason, status, reviewed_at)
                 VALUES (?,?,?,?,?,?,?,?,'approved',NOW())`,
                [interaction.user.id, interaction.user.tag, firstname, lastname, dob, gender, height, reason]
            );
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') return interaction.editReply('⚠️ คุณลงทะเบียนไปแล้วครับ!');
            console.error(e);
            return interaction.editReply('❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
        }

        // ให้ Role ทันที
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (member) await member.roles.add(process.env.WHITELIST_ROLE_ID).catch(console.error);

        // Log ไปห้อง staff
        const [[logRow]] = await db.execute(
            'SELECT value FROM lavan_bot_config WHERE key_name="log_channel_id"'
        ).catch(() => [[null]]);
        if (logRow) {
            const logCh = interaction.guild.channels.cache.get(logRow.value);
            if (logCh) {
                await logCh.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x22c55e)
                            .setTitle('✅ ลงทะเบียนสำเร็จ (Auto-approved)')
                            .setThumbnail(interaction.user.displayAvatarURL())
                            .addFields(
                                { name: 'Discord',   value: `<@${interaction.user.id}>\n\`${interaction.user.tag}\``, inline: true },
                                { name: 'ตัวละคร',  value: `${firstname} ${lastname}`,                               inline: true },
                                { name: 'เพศ / สูง',value: `${gender === 'm' ? 'ชาย' : gender === 'f' ? 'หญิง' : 'LGBTQ+'} / ${height} ซม.`,   inline: true },
                                { name: 'วันเกิด',  value: dob,                                                       inline: true },
                                { name: 'เหตุผล',   value: reason }
                            )
                            .setTimestamp()
                            .setFooter({ text: 'Lavan Whitelist System' })
                    ]
                });
            }
        }

        // Reply สำเร็จพร้อม embed สวย
        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xC9A84C)
                    .setTitle('🎉 ลงทะเบียนสำเร็จ!')
                    .setDescription(
                        `ยินดีต้อนรับสู่ **Lavan Community** คุณ **${firstname} ${lastname}**!\n\n` +
                        '✅ ได้รับ **Role Whitelist** แล้ว\n' +
                        '✅ ข้อมูลตัวละครบันทึกแล้ว\n' +
                        '✅ เข้าเกมได้เลย ข้อมูลจะกรอกอัตโนมัติ\n\n' +
                        '> เข้าเกมผ่าน FiveM แล้วค้นหา **Lavan Community**'
                    )
                    .setFooter({ text: 'Lavan Community · FiveM RP Server' })
                    .setTimestamp()
            ]
        });
    }

    // ── /ตรวจสอบ ─────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'ตรวจสอบ') {
        const [rows] = await db.execute(
            'SELECT * FROM lavan_whitelist WHERE discord_id=?', [interaction.user.id]
        );
        if (!rows.length) {
            return interaction.reply({ content: '❓ คุณยังไม่ได้ลงทะเบียน ไปที่ห้อง 📋︱ลงทะเบียน ได้เลยครับ', ephemeral: true });
        }
        const r = rows[0];
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(r.status === 'approved' ? 0x22c55e : 0xef4444)
                    .setTitle('📋 สถานะ Whitelist ของคุณ')
                    .setThumbnail(interaction.user.displayAvatarURL())
                    .addFields(
                        { name: 'สถานะ',      value: r.status === 'approved' ? '✅ Whitelisted' : '❌ ถูกระงับ', inline: true },
                        { name: 'ตัวละคร',   value: `${r.firstname} ${r.lastname}`,                              inline: true },
                        { name: 'ลงทะเบียน', value: new Date(r.applied_at).toLocaleDateString('th-TH'),         inline: true }
                    )
            ],
            ephemeral: true
        });
    }

    // ── /ถอน-whitelist ────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'ถอน-whitelist') {
        const target = interaction.options.getUser('ผู้ใช้');
        await db.execute(
            'UPDATE lavan_whitelist SET status="denied" WHERE discord_id=?', [target.id]
        );
        const m = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (m) await m.roles.remove(process.env.WHITELIST_ROLE_ID).catch(() => {});
        await interaction.reply({ content: `✅ ถอน Whitelist ของ **${target.tag}** แล้ว`, ephemeral: true });
        try { await target.send('⛔ Whitelist ของคุณบน **Lavan Community** ถูกระงับ กรุณาติดต่อ Staff'); } catch {}
    }

});

// ── Ready ────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`\n🤖 ${client.user.tag} พร้อมใช้งานแล้ว!`);
    await initDB();
    await registerCommands();
    client.user.setActivity('Lavan Community | กดลงทะเบียน!', { type: 3 });
    console.log('✅ Lavan Whitelist Bot ready!\n');
});

client.login(process.env.BOT_TOKEN);