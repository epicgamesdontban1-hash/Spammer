const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const mineflayer = require('mineflayer');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');

// Configuration from environment variables
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CHANNEL_ID: process.env.CHANNEL_ID,
    MINECRAFT_HOST: process.env.MINECRAFT_HOST,
    MINECRAFT_PORT: parseInt(process.env.MINECRAFT_PORT || '25565'),
    MINECRAFT_USERNAME: process.env.MINECRAFT_USERNAME,
    SECRETS_FILE: path.join(__dirname, 'secrets.json')
};

class MinecraftBotController {
    constructor() {
        this.discordClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        this.mcBot = null;
        this.controlMessage = null;
        this.isConnecting = false;
        this.msaAuth = null;
        this.secrets = { messageId: null };
        this.reconnectTimeout = null;
        this.app = express();
        this.setupWebServer();
    }

    setupWebServer() {
        this.app.get('/', (req, res) => {
            const status = this.mcBot ? 'Connected' : 'Disconnected';
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>ShitMC Spammer</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            max-width: 600px;
                            margin: 50px auto;
                            padding: 20px;
                            background: #1a1a1a;
                            color: #fff;
                        }
                        .status {
                            padding: 20px;
                            border-radius: 10px;
                            background: #2a2a2a;
                            margin: 20px 0;
                        }
                        .status-indicator {
                            display: inline-block;
                            width: 12px;
                            height: 12px;
                            border-radius: 50%;
                            margin-right: 8px;
                            background: ${this.mcBot ? '#00ff00' : '#ff0000'};
                        }
                        h1 { color: #5865F2; }
                        .info { margin: 10px 0; }
                    </style>
                </head>
                <body>
                    <h1>Spamming a shitty server's console</h1>
                    <div class="status">
                        <h2><span class="status-indicator"></span>${status}</h2>
                        <div class="info"><strong>Server:</strong> ${CONFIG.MINECRAFT_HOST}:${CONFIG.MINECRAFT_PORT}</div>
                        <div class="info"><strong>Username:</strong> ${CONFIG.MINECRAFT_USERNAME}</div>
                        <div class="info"><strong>Uptime:</strong> ${hours}h ${minutes}m ${seconds}s</div>
                    </div>
                </body>
                </html>
            `);
        });

        this.app.get('/status', (req, res) => {
            res.json({
                connected: !!this.mcBot,
                isConnecting: this.isConnecting,
                server: CONFIG.MINECRAFT_HOST,
                port: CONFIG.MINECRAFT_PORT,
                username: CONFIG.MINECRAFT_USERNAME,
                uptime: process.uptime()
            });
        });

        this.app.listen(10000, () => {
            console.log('[Web] Server running on port 10000');
        });
    }

    async loadSecrets() {
        try {
            const data = await fs.readFile(CONFIG.SECRETS_FILE, 'utf8');
            this.secrets = JSON.parse(data);
        } catch (error) {
            this.secrets = { messageId: null };
        }
    }

    async saveSecrets() {
        await fs.writeFile(CONFIG.SECRETS_FILE, JSON.stringify(this.secrets, null, 2));
    }

    createEmbed(status, details = '') {
        const embed = new EmbedBuilder()
            .setTitle('🎮 Minecraft Bot Control Center')
            .setColor(status === 'connected' ? 0x00ff00 : 
                     status === 'connecting' ? 0xffaa00 : 
                     status === 'msa' ? 0x0099ff : 0xff0000)
            .setTimestamp();

        if (status === 'disconnected') {
            embed.setDescription('Bot is currently **disconnected** from the Minecraft server.');
        } else if (status === 'connecting') {
            embed.setDescription(`Bot is **connecting** to the server...\n${details}`);
        } else if (status === 'connected') {
            embed.setDescription(`Bot is **connected** to the server!\n${details}`);
        } else if (status === 'msa') {
            embed.setDescription('**Microsoft Authentication Required**')
                .addFields(
                    { name: '🔗 Login URL', value: details.url || 'Loading...', inline: false },
                    { name: '🔑 Code', value: `\`${details.code || 'Loading...'}\``, inline: false },
                    { name: 'ℹ️ Instructions', value: 'Click the link above and enter the code to authenticate.', inline: false }
                );
        } else if (status === 'error') {
            embed.setDescription(`**Error:** ${details}\n\nRetrying in 2 seconds...`);
        }

        return embed;
    }

    createButtons(connected) {
        const row = new ActionRowBuilder();

        if (connected) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('disconnect')
                    .setLabel('Disconnect')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔌')
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('connect')
                    .setLabel('Connect')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔗')
            );
        }

        return row;
    }

    async updateControlMessage(status, details = '') {
        if (!this.controlMessage) return;

        const embed = this.createEmbed(status, details);
        const buttons = this.createButtons(status === 'connected');

        await this.controlMessage.edit({
            embeds: [embed],
            components: [buttons]
        });
    }

    async connectMinecraft() {
        if (this.isConnecting || this.mcBot) return;
        this.isConnecting = true;

        try {
            await this.updateControlMessage('connecting', 'Initializing connection...');

            const botOptions = {
                host: CONFIG.MINECRAFT_HOST,
                port: CONFIG.MINECRAFT_PORT,
                username: CONFIG.MINECRAFT_USERNAME,
                auth: 'microsoft',
                version: false,
                onMsaCode: (data) => {
                    console.log('[MSA] onMsaCode callback triggered:', data);
                    this.msaAuth = data;

                    // Extract URL and code from the MSA data
                    const code = data.user_code || data.userCode || 'N/A';
                    const baseUrl = data.verification_uri || data.verificationUri || 'https://www.microsoft.com/link';
                    const url = `${baseUrl}?otc=${code}`;

                    console.log(`[MSA] URL: ${url}, Code: ${code}`);

                    this.updateControlMessage('msa', {
                        url: url,
                        code: code
                    });
                }
            };

            this.mcBot = mineflayer.createBot(botOptions);

            // Successful spawn
            this.mcBot.on('spawn', () => {
                console.log('[MC] Bot spawned successfully!');
                this.isConnecting = false;
                this.msaAuth = null;
                const position = this.mcBot.entity.position;
                this.updateControlMessage('connected', 
                    `Position: ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)}`
                );
            });

            // Error handler with retry logic
            this.mcBot.on('error', (err) => {
                console.error('[MC] Error:', err.message);
                this.updateControlMessage('error', err.message);

                // Cleanup
                if (this.mcBot) {
                    this.mcBot.end();
                    this.mcBot = null;
                }
                this.isConnecting = false;

                // Retry after 2 seconds
                this.reconnectTimeout = setTimeout(() => {
                    console.log('[MC] Retrying connection...');
                    this.connectMinecraft();
                }, 2000);
            });

            // Kick handler with retry logic
            this.mcBot.on('kicked', (reason) => {
                console.log('[MC] Kicked:', reason);
                this.updateControlMessage('error', `Kicked: ${reason}`);

                this.mcBot = null;
                this.isConnecting = false;

                // Retry after 2 seconds
                this.reconnectTimeout = setTimeout(() => {
                    console.log('[MC] Retrying after kick...');
                    this.connectMinecraft();
                }, 2000);
            });

            // End handler
            this.mcBot.on('end', () => {
                console.log('[MC] Connection ended');
                if (this.mcBot) {
                    this.mcBot = null;
                    this.isConnecting = false;
                }
            });

        } catch (error) {
            console.error('[MC] Connection error:', error);
            this.updateControlMessage('error', error.message);
            this.isConnecting = false;
            this.mcBot = null;

            // Retry after 2 seconds
            this.reconnectTimeout = setTimeout(() => {
                console.log('[MC] Retrying after error...');
                this.connectMinecraft();
            }, 2000);
        }
    }

    async disconnectMinecraft() {
        if (this.mcBot) {
            this.mcBot.end();
            this.mcBot = null;
        }
        this.isConnecting = false;
        this.msaAuth = null;

        // Clear any pending reconnection attempts
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        await this.updateControlMessage('disconnected');
    }

    async setupDiscord() {
        this.discordClient.on('ready', async () => {
            console.log(`[Discord] Logged in as ${this.discordClient.user.tag}`);

            const channel = await this.discordClient.channels.fetch(CONFIG.CHANNEL_ID);

            // Check if we have a saved message ID
            if (this.secrets.messageId) {
                try {
                    this.controlMessage = await channel.messages.fetch(this.secrets.messageId);
                    console.log('[Discord] Found existing control message');
                } catch (error) {
                    console.log('[Discord] Previous message not found, creating new one');
                    this.controlMessage = null;
                }
            }

            // Create new message if none exists
            if (!this.controlMessage) {
                const embed = this.createEmbed('disconnected');
                const buttons = this.createButtons(false);

                this.controlMessage = await channel.send({
                    embeds: [embed],
                    components: [buttons]
                });

                this.secrets.messageId = this.controlMessage.id;
                await this.saveSecrets();
                console.log('[Discord] Created new control message');
            } else {
                // Update existing message
                await this.updateControlMessage('disconnected');
            }

            // Auto-connect on startup
            console.log('[Discord] Auto-connecting to Minecraft...');
            await this.connectMinecraft();
        });

        this.discordClient.on('interactionCreate', async (interaction) => {
            if (!interaction.isButton()) return;
            if (interaction.message.id !== this.controlMessage.id) return;

            await interaction.deferUpdate();

            if (interaction.customId === 'connect') {
                console.log('[Discord] Connect button pressed');
                await this.connectMinecraft();
            } else if (interaction.customId === 'disconnect') {
                console.log('[Discord] Disconnect button pressed');
                await this.disconnectMinecraft();
            }
        });
    }

    async start() {
        await this.loadSecrets();
        await this.setupDiscord();
        await this.discordClient.login(CONFIG.DISCORD_TOKEN);
    }
}

// Start the bot
const controller = new MinecraftBotController();
controller.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down...');
    if (controller.mcBot) {
        controller.mcBot.end();
    }
    await controller.discordClient.destroy();
    process.exit(0);
});
