const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  REST,
  Routes,
  MessageFlags,
} = require("discord.js");

// ─── PROCESS-LEVEL SAFETY ─────────────────────────────────────────────────────
process.on("unhandledRejection", (err) => {
  console.error("[UnhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const JOIN_CHANNEL_ID   = "1491557465727307948";
const MEMBER_ROLE_ID    = "1488521626059542538";
const SUPPORT_ROLE_ID   = "1489297553261334759";
const TICKET_CATEGORY   = "1488455923486691450";
const EMBED_COLOR       = 0x0c0c0c;

const EMOJIS = [
  "🥕","🌶️","👜","🦇","🐨","🐹","🪲","🦐","🦩","🍋","🥥","🍕","🍫","🥜",
  "🪂","🏓","🎲","🫑","🍔","👻","🍓","🌸","⏰","🍯","🐼","🐊","🍄","🍏",
  "🏹","🧸","🎀","🍩","🥝","💨",
];

// ─── STATE ────────────────────────────────────────────────────────────────────
const tempChannels   = new Map();
const tickets        = new Map();
const claimedTickets = new Map();
const handledInteractions = new Set();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function randomEmoji() {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}

function stripEmojis(str) {
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function feedbackEmbed(text) {
  return new EmbedBuilder().setColor(EMBED_COLOR).setDescription(text);
}

function timestamp() {
  return new Date().toLocaleString("en-US", {
    hour: "2-digit", minute: "2-digit",
    month: "short", day: "numeric", year: "numeric",
  });
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {}
}

// ─── VOICE PANEL ──────────────────────────────────────────────────────────────
async function buildVoiceEmbed(guild, channelId, data) {
  const owner = await guild.members.fetch(data.ownerId).catch(() => null);
  const voiceChannel = guild.channels.cache.get(channelId);
  const connectedMembers = voiceChannel
    ? [...voiceChannel.members.values()].filter((m) => !m.user.bot)
    : [];

  const memberMentions = connectedMembers.length > 0
    ? connectedMembers.map((m) => `<@${m.id}>`).join("\n")
    : "Nobody";

  const trustedCount  = data.locked ? data.trusted.size : 0;
  const limitDisplay  = voiceChannel && voiceChannel.userLimit > 0
    ? `${connectedMembers.length}/${voiceChannel.userLimit}`
    : "♾️";
  const statusEmoji   = data.locked ? "🔒" : "🔓";
  const statusText    = data.locked ? "Locked" : "Unlocked";
  const thumbnail     = owner?.user.displayAvatarURL() ?? null;
  const guildIcon     = guild.iconURL() ?? null;

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("🎙️ __**Voice Control Panel**__")
    .setDescription(
      `**Welcome to your temp voice! You can manage your channel by using the buttons below.**\n\n` +
      `⭐️ **Owner:** <@${data.ownerId}>\n` +
      `${statusEmoji} **Status:** ${statusText}\n` +
      `👥 **Connected members:**\n${memberMentions}\n` +
      `**🖇️ User Limit:** ${limitDisplay}\n` +
      `🫂 **Trusted:** ${trustedCount}`
    )
    .setThumbnail(thumbnail)
    .setFooter({ text: `${guild.name} | ${timestamp()}`, iconURL: guildIcon });
}

function buildVoiceButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("vc_lock").setLabel("Lock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_unlock").setLabel("Unlock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_trust").setLabel("Trust User").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_untrust").setLabel("Untrust User").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("vc_kick").setLabel("Kick User").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_disconnect").setLabel("Disconnect User").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_claim").setLabel("Claim Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vc_delete").setLabel("Delete Channel").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function updatePanel(channelId) {
  const data = tempChannels.get(channelId);
  if (!data || !data.panelMessageId || data.panelSending) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const embed      = await buildVoiceEmbed(channel.guild, channelId, data);
  const components = buildVoiceButtons();
  const msg        = await channel.messages.fetch(data.panelMessageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [embed], components }).catch(() => {});
}

// ─── SWEEP: delete empty tracked channels ─────────────────────────────────────
async function sweepEmptyChannels(guild, skipChannelId = null) {
  for (const [channelId] of [...tempChannels]) {
    if (channelId === skipChannelId) continue;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      tempChannels.delete(channelId);
      continue;
    }
    const humans = channel.members.filter((m) => !m.user.bot);
    if (humans.size === 0) {
      tempChannels.delete(channelId);
      await channel.delete().catch(() => {});
    }
  }
}

// ─── VOICE STATE UPDATE ───────────────────────────────────────────────────────
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;

  if (newState.channelId === JOIN_CHANNEL_ID) {
    const member = newState.member;
    if (!member) return;

    const existing = [...tempChannels.entries()].find(([, d]) => d.ownerId === member.id);
    if (existing) {
      const [existingId, existingData] = existing;
      const existingVc = guild.channels.cache.get(existingId);
      const others = existingVc
        ? [...existingVc.members.values()].filter((m) => !m.user.bot && m.id !== member.id)
        : [];

      if (others.length === 0) {
        // Old channel is empty — delete it and fall through to create a new one
        tempChannels.delete(existingId);
        if (existingVc) await existingVc.delete().catch(() => {});
      } else {
        // Old channel still has people — transfer ownership to first remaining member
        existingData.ownerId = others[0].id;
        existingData.trusted.clear();
        await updatePanel(existingId);
        // Fall through to create a new channel for this user
      }
    }

    const emoji       = randomEmoji();
    const cleanName   = stripEmojis(member.displayName) || stripEmojis(member.user.username) || "User";
    const channelName = `${emoji}・${cleanName}`;
    const category    = guild.channels.cache.get(JOIN_CHANNEL_ID)?.parentId ?? null;

    const voiceChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: category,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.Connect],
        },
        {
          id: MEMBER_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.Stream,
            PermissionFlagsBits.UseSoundboard,
            PermissionFlagsBits.UseExternalSounds,
            PermissionFlagsBits.UseVAD,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.UseApplicationCommands,
            PermissionFlagsBits.UseEmbeddedActivities,
          ],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.Stream,
            PermissionFlagsBits.UseSoundboard,
            PermissionFlagsBits.UseExternalSounds,
            PermissionFlagsBits.UseVAD,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.UseApplicationCommands,
            PermissionFlagsBits.UseEmbeddedActivities,
          ],
        },
      ],
    }).catch(() => null);

    if (!voiceChannel) return;

    const data = {
      ownerId: member.id,
      panelMessageId: null,
      panelSending: true,
      trusted: new Set(),
      kicked: new Set(),
      locked: false,
    };
    tempChannels.set(voiceChannel.id, data);

    await member.voice.setChannel(voiceChannel).catch(() => {});

    const embed = await buildVoiceEmbed(guild, voiceChannel.id, data);
    const msg   = await voiceChannel.send({
      embeds: [embed],
      components: buildVoiceButtons(),
    }).catch(() => null);

    if (msg) data.panelMessageId = msg.id;
    data.panelSending = false;

    await sweepEmptyChannels(guild, voiceChannel.id);
    return;
  }

  await sweepEmptyChannels(guild);

  if (
    newState.channelId &&
    newState.channelId !== JOIN_CHANNEL_ID &&
    tempChannels.has(newState.channelId)
  ) {
    await updatePanel(newState.channelId);
  }

  if (
    oldState.channelId &&
    oldState.channelId !== JOIN_CHANNEL_ID &&
    tempChannels.has(oldState.channelId)
  ) {
    await updatePanel(oldState.channelId);
  }
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (handledInteractions.has(interaction.id)) return;
  handledInteractions.add(interaction.id);
  setTimeout(() => handledInteractions.delete(interaction.id), 10000);

  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ticketpanel") await handleTicketPanelCommand(interaction);
      return;
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if      (interaction.customId.startsWith("modal_trust_"))      await handleTrustModal(interaction);
      else if (interaction.customId.startsWith("modal_untrust_"))    await handleUntrustModal(interaction);
      else if (interaction.customId.startsWith("modal_kick_"))       await handleKickModal(interaction);
      else if (interaction.customId.startsWith("modal_disconnect_")) await handleDisconnectModal(interaction);
      else if (interaction.customId === "modal_close_confirm")       await handleCloseConfirmModal(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    const id = interaction.customId;
    if (id.startsWith("vc_"))  { await handleVoiceButton(interaction, id); return; }
    if (id === "ticket_open")  { await handleTicketOpen(interaction);      return; }
    if (id === "ticket_claim") { await handleTicketClaim(interaction);     return; }
    if (id === "ticket_close") { await handleTicketClose(interaction);     return; }
  } catch (err) {
    console.error("[InteractionError]", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [feedbackEmbed("Something went wrong.")], flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

// ─── VOICE BUTTONS ────────────────────────────────────────────────────────────
async function handleVoiceButton(interaction, customId) {
  const channel   = interaction.channel;
  const member    = interaction.member;
  const guild     = interaction.guild;
  const channelId = channel.id;
  const data      = tempChannels.get(channelId);

  if (!data) {
    await safeReply(interaction, { embeds: [feedbackEmbed("This temp voice is no longer active.")] });
    return;
  }

  const isOwner = data.ownerId === member.id;

  // ── CLAIM ──
  if (customId === "vc_claim") {
    const vc           = guild.channels.cache.get(channelId);
    const ownerPresent = vc?.members.has(data.ownerId);
    const selfPresent  = vc?.members.has(member.id);

    if (ownerPresent) {
      await safeReply(interaction, { embeds: [feedbackEmbed("The owner is still in the channel.")] });
      return;
    }
    if (!selfPresent) {
      await safeReply(interaction, { embeds: [feedbackEmbed("You must be in the voice channel to claim it.")] });
      return;
    }

    data.ownerId = member.id;
    data.trusted.clear();

    // Reply FIRST — Discord requires a response within 3 seconds
    await safeReply(interaction, { embeds: [feedbackEmbed("✅ You have claimed the channel! You are now the owner.")] });

    // Give the claimer an explicit owner-level overwrite so lock/unlock never affects them
    if (vc) {
      await vc.permissionOverwrites.edit(member.id, {
        ViewChannel: true,
        Connect: true,
        Speak: true,
        Stream: true,
        SendMessages: true,
        ReadMessageHistory: true,
        UseApplicationCommands: true,
        UseSoundboard: true,
        UseExternalSounds: true,
        UseVAD: true,
        UseEmbeddedActivities: true,
      }).catch(() => {});
    }

    await updatePanel(channelId);
    return;
  }

  // All remaining buttons: owner only
  if (!isOwner) {
    await safeReply(interaction, { embeds: [feedbackEmbed("Only the channel owner can use this.")] });
    return;
  }

  if (customId === "vc_lock") {
    data.locked = true;
    await safeReply(interaction, { embeds: [feedbackEmbed("🔒 Channel locked.")] });
    await channel.permissionOverwrites.edit(MEMBER_ROLE_ID, { Connect: false }).catch(() => {});
    await updatePanel(channelId);

  } else if (customId === "vc_unlock") {
    data.locked = false;
    await safeReply(interaction, { embeds: [feedbackEmbed("🔓 Channel unlocked.")] });
    await channel.permissionOverwrites.edit(MEMBER_ROLE_ID, { Connect: true }).catch(() => {});
    await updatePanel(channelId);

  } else if (customId === "vc_trust") {
    await interaction.showModal(buildModal(`modal_trust_${channelId}`, "Trust User", "User ID to trust"));

  } else if (customId === "vc_untrust") {
    await interaction.showModal(buildModal(`modal_untrust_${channelId}`, "Untrust User", "User ID to untrust"));

  } else if (customId === "vc_kick") {
    await interaction.showModal(buildModal(`modal_kick_${channelId}`, "Kick User", "User ID to kick"));

  } else if (customId === "vc_disconnect") {
    await interaction.showModal(buildModal(`modal_disconnect_${channelId}`, "Disconnect User", "User ID to disconnect"));

  } else if (customId === "vc_delete") {
    await safeReply(interaction, { embeds: [feedbackEmbed("🗑️ Deleting channel...")] });
    tempChannels.delete(channelId);
    await channel.delete().catch(() => {});
  }
}

function buildModal(customId, title, label) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("user_id")
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

// ─── MODAL HANDLERS ───────────────────────────────────────────────────────────
function parseUserId(raw) {
  return raw.trim().replace(/[<@!>]/g, "");
}

async function handleTrustModal(interaction) {
  const channelId = interaction.customId.replace("modal_trust_", "");
  const data      = tempChannels.get(channelId);
  if (!data) { await safeReply(interaction, { embeds: [feedbackEmbed("Channel no longer exists.")] }); return; }

  const userId  = parseUserId(interaction.fields.getTextInputValue("user_id"));
  const channel = interaction.guild.channels.cache.get(channelId);

  await safeReply(interaction, { embeds: [feedbackEmbed(`✅ <@${userId}> has been trusted.`)] });
  data.trusted.add(userId);
  if (channel) {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true, Connect: true, Speak: true, Stream: true,
      SendMessages: true, ReadMessageHistory: true, UseApplicationCommands: true,
    }).catch(() => {});
  }
  await updatePanel(channelId);
}

async function handleUntrustModal(interaction) {
  const channelId = interaction.customId.replace("modal_untrust_", "");
  const data      = tempChannels.get(channelId);
  if (!data) { await safeReply(interaction, { embeds: [feedbackEmbed("Channel no longer exists.")] }); return; }

  const userId  = parseUserId(interaction.fields.getTextInputValue("user_id"));
  const channel = interaction.guild.channels.cache.get(channelId);

  await safeReply(interaction, { embeds: [feedbackEmbed(`✅ <@${userId}> has been untrusted.`)] });
  data.trusted.delete(userId);
  if (channel) await channel.permissionOverwrites.edit(userId, { Connect: false }).catch(() => {});
  await updatePanel(channelId);
}

async function handleKickModal(interaction) {
  const channelId = interaction.customId.replace("modal_kick_", "");
  const data      = tempChannels.get(channelId);
  if (!data) { await safeReply(interaction, { embeds: [feedbackEmbed("Channel no longer exists.")] }); return; }

  const userId  = parseUserId(interaction.fields.getTextInputValue("user_id"));
  const channel = interaction.guild.channels.cache.get(channelId);

  await safeReply(interaction, { embeds: [feedbackEmbed(`✅ <@${userId}> has been kicked.`)] });
  data.kicked.add(userId);
  data.trusted.delete(userId);
  if (channel) {
    await channel.permissionOverwrites.edit(userId, { Connect: false }).catch(() => {});
    const target = channel.members.get(userId);
    if (target) await target.voice.disconnect().catch(() => {});
  }
  await updatePanel(channelId);
}

async function handleDisconnectModal(interaction) {
  const channelId = interaction.customId.replace("modal_disconnect_", "");
  const data      = tempChannels.get(channelId);
  if (!data) { await safeReply(interaction, { embeds: [feedbackEmbed("Channel no longer exists.")] }); return; }

  const userId  = parseUserId(interaction.fields.getTextInputValue("user_id"));
  const channel = interaction.guild.channels.cache.get(channelId);

  await safeReply(interaction, { embeds: [feedbackEmbed(`✅ <@${userId}> has been disconnected.`)] });
  if (channel) {
    const target = channel.members.get(userId);
    if (target) await target.voice.disconnect().catch(() => {});
  }
  await updatePanel(channelId);
}

// ─── TICKET SYSTEM ────────────────────────────────────────────────────────────
async function handleTicketPanelCommand(interaction) {
  if (!interaction.member.roles.cache.has(SUPPORT_ROLE_ID)) {
    await interaction.reply({ embeds: [feedbackEmbed("You don't have permission to use this command.")], flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("💌 __**Support Ticket**__")
    .setDescription(
      `**Need Help? Click on the Contact Staff button below to open a support ticket!**\n\n` +
      `__**Read Before Creating:**__\n` +
      `**• Make sure to give staff members clear information about your issue**\n` +
      `**• Reporting a member needs proof ( recordings/screenshots) otherwise it'll be considered as a fake report.**`
    )
    .setImage("https://cdn.discordapp.com/attachments/1488273264836087959/1499519967987761322/2A042261-364C-4384-852A-C0C53E019B41.png?ex=69f5184c&is=69f3c6cc&hm=13e3c8782f913023b8017599cff8872653bd0de06c6fbff916237ffb2c228740&")
    .setFooter({ text: `${guild.name} | ${timestamp()}`, iconURL: guild.iconURL() ?? null });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_open").setLabel("Contact Staff").setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [feedbackEmbed("✅ Ticket panel sent!")], flags: MessageFlags.Ephemeral });
  await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleTicketOpen(interaction) {
  const member = interaction.member;
  const guild  = interaction.guild;

  if (!member.roles.cache.has(MEMBER_ROLE_ID)) {
    await interaction.reply({ embeds: [feedbackEmbed("You don't have permission to create a ticket.")], flags: MessageFlags.Ephemeral });
    return;
  }

  if (tickets.has(member.id)) {
    const existingChannel = guild.channels.cache.get(tickets.get(member.id));
    if (existingChannel) {
      await interaction.reply({ embeds: [feedbackEmbed("💌 You already have an active ticket!")], flags: MessageFlags.Ephemeral });
      return;
    }
    tickets.delete(member.id);
  }

  await interaction.reply({ embeds: [feedbackEmbed("💌 Creating your ticket...")], flags: MessageFlags.Ephemeral });

  const ticketChannel = await guild.channels.create({
    name: `ticket-${member.user.username}`,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY,
    permissionOverwrites: [
      { id: guild.id,        deny:  [PermissionFlagsBits.ViewChannel] },
      { id: member.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands] },
      { id: SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands] },
    ],
  }).catch(() => null);

  if (!ticketChannel) {
    await interaction.editReply({ embeds: [feedbackEmbed("❌ Failed to create ticket. Please contact staff.")], components: [] });
    return;
  }

  tickets.set(member.id, ticketChannel.id);

  const welcomeEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(
      `**__Hello <@${member.id}>__**\n\n` +
      `**Thank you for reaching out! Please describe your issue in detail, and a staff member will assist you as soon as possible.**\n\n` +
      `**Guidelines:**\n` +
      `**• Mention spam is prohibited**\n` +
      `**• One issue per ticket**\n` +
      `**• Trolling inside of the ticket could get you punished.**`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Secondary),
  );

  await ticketChannel.send({ embeds: [welcomeEmbed], components: [row] });
  await interaction.editReply({ embeds: [feedbackEmbed(`✅ Ticket created: <#${ticketChannel.id}>`)], components: [] });
}

async function handleTicketClaim(interaction) {
  const channel = interaction.channel;
  const member  = interaction.member;

  if (!member.roles.cache.has(SUPPORT_ROLE_ID)) {
    await interaction.reply({ embeds: [feedbackEmbed("Only staff members can claim tickets.")], flags: MessageFlags.Ephemeral });
    return;
  }

  if (claimedTickets.has(channel.id)) {
    const claimerId = claimedTickets.get(channel.id);
    await interaction.reply({ embeds: [feedbackEmbed(`Already claimed by <@${claimerId}>.`)], flags: MessageFlags.Ephemeral });
    return;
  }

  claimedTickets.set(channel.id, member.id);

  const updatedRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_claimed_placeholder")
      .setLabel(`Claimed by ${member.displayName}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ components: [updatedRow] });

  await channel.permissionOverwrites.edit(SUPPORT_ROLE_ID, { ViewChannel: false }).catch(() => {});
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true, SendMessages: true, AttachFiles: true,
    EmbedLinks: true, ReadMessageHistory: true, UseApplicationCommands: true,
  }).catch(() => {});
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  const member  = interaction.member;

  const isStaff  = member.roles.cache.has(SUPPORT_ROLE_ID);
  const entry    = [...tickets.entries()].find(([, cid]) => cid === channel.id);
  const isOwner  = entry && entry[0] === member.id;
  const isClaimer = claimedTickets.get(channel.id) === member.id;

  if (!isStaff && !isOwner && !isClaimer) {
    await interaction.reply({ embeds: [feedbackEmbed("You don't have permission to close this ticket.")], flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId("modal_close_confirm")
      .setTitle("Close Ticket")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("confirm")
            .setLabel('Type "close" to confirm')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      )
  );
}

async function handleCloseConfirmModal(interaction) {
  const confirm = interaction.fields.getTextInputValue("confirm").trim().toLowerCase();

  if (confirm !== "close") {
    await interaction.reply({ embeds: [feedbackEmbed("Confirmation didn't match. Ticket not closed.")], flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.channel;
  await interaction.reply({ embeds: [feedbackEmbed("🔒 Closing ticket in 3 seconds...")], flags: MessageFlags.Ephemeral });

  const entry = [...tickets.entries()].find(([, cid]) => cid === channel.id);
  if (entry) tickets.delete(entry[0]);
  claimedTickets.delete(channel.id);

  setTimeout(() => channel.delete().catch(() => {}), 3000);
}

// ─── STARTUP: REGISTER SLASH COMMANDS ────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  const commands = [
    { name: "ticketpanel", description: "Send the support ticket panel in this channel" },
  ];

  for (const guild of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    ).catch(console.error);
  }

  console.log("Slash commands registered. Bot is ready.");
});

client.login(process.env.DISCORD_BOT_TOKEN);
