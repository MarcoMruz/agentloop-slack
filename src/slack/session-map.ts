export interface ThreadInfo {
  channelId: string;
  threadTs: string;
  userId: string;
  /** TS of the bot's streaming message (for chat.update) */
  messageTs?: string;
  /** Cleanup function to remove event listeners */
  cleanup?: () => void;
}

/**
 * Bidirectional map between AgentLoop session IDs and Slack threads.
 * Allows looking up a session from a thread reply, or a thread from an event.
 */
export class SessionMap {
  private bySession = new Map<string, ThreadInfo>();
  private byThread = new Map<string, string>(); // "channelId:threadTs" -> sessionId

  private threadKey(channelId: string, threadTs: string): string {
    return `${channelId}:${threadTs}`;
  }

  set(sessionId: string, info: ThreadInfo) {
    this.bySession.set(sessionId, info);
    this.byThread.set(this.threadKey(info.channelId, info.threadTs), sessionId);
  }

  getBySession(sessionId: string): ThreadInfo | undefined {
    return this.bySession.get(sessionId);
  }

  getByThread(channelId: string, threadTs: string): string | undefined {
    return this.byThread.get(this.threadKey(channelId, threadTs));
  }

  remove(sessionId: string) {
    const info = this.bySession.get(sessionId);
    if (info) {
      this.byThread.delete(this.threadKey(info.channelId, info.threadTs));
      info.cleanup?.();
    }
    this.bySession.delete(sessionId);
  }

  /** Get all active session IDs */
  activeSessions(): string[] {
    return Array.from(this.bySession.keys());
  }
}
