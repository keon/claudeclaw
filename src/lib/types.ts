export type AccessPolicy = "pairing" | "allowlist" | "disabled";

export type AccessConfig = {
  dmPolicy: AccessPolicy;
  allowFrom: string[];
  pendingPairings: Map<string, PendingPairing>;
};

export type PendingPairing = {
  code: string;
  platformUserId: string;
  platformUsername?: string;
  createdAt: number;
  reminders: number;
};

export type ChannelNotification = {
  content: string;
  meta: Record<string, string>;
};

export type InboundMessage = {
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  replyToMessageId?: string;
  attachments?: InboundAttachment[];
};

export type InboundAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
};

export type OutboundReply = {
  chatId: string;
  text: string;
  replyTo?: string;
  files?: string[];
};
