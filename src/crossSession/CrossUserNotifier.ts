import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { UserDirectory } from './UserDirectory';
import type { SessionRegistry } from './SessionRegistry';
import { createLogger } from '../logger';

const log = createLogger({ module: 'CrossUserNotifier' });

const MAX_INBOX_SIZE = 500;

export interface UserNotification {
  id: string;
  fromUserId: string;
  targetUserId: string;
  type: 'notification' | 'request' | 'collaboration_invite';
  content: string;
  payload?: {
    project?: string;
    urgency?: 'low' | 'normal' | 'high';
    actionRequired?: boolean;
    [key: string]: unknown;
  };
  createdAt: Date;
  readAt?: Date;
}

/**
 * Manages cross-user notifications.
 * Built on top of the existing multi-tenant user system.
 */
export class CrossUserNotifier extends EventEmitter {
  private notifications = new Map<string, UserNotification>();
  /** userId -> ordered list of notificationIds */
  private userInbox = new Map<string, string[]>();

  constructor(
    private directory: UserDirectory,
    private registry: SessionRegistry,
  ) {
    super();
  }

  /**
   * Send a notification to a specific user.
   * Respects target user's messagePermission setting.
   * Returns the notification ID, or null if blocked by permission.
   */
  notifyUser(notification: Omit<UserNotification, 'id' | 'createdAt'>): string | null {
    if (!this.directory.canReceiveFrom(notification.targetUserId, notification.fromUserId)) {
      log.debug(
        { from: notification.fromUserId, to: notification.targetUserId },
        'Notification blocked by permission'
      );
      return null;
    }

    const id = randomUUID();
    const full: UserNotification = { ...notification, id, createdAt: new Date() };

    this.notifications.set(id, full);
    this.addToInbox(notification.targetUserId, id);

    log.debug(
      { id, from: notification.fromUserId, to: notification.targetUserId, type: notification.type },
      'Notification sent'
    );
    this.emit('notification', { userId: notification.targetUserId, notification: full });
    return id;
  }

  /**
   * Notify all members of a project.
   * Returns the IDs of notifications that were created (some may be blocked by permissions).
   */
  notifyProjectMembers(
    fromUserId: string,
    projectName: string,
    type: UserNotification['type'],
    content: string,
    excludeUserIds: string[] = [],
  ): string[] {
    const members = this.directory
      .getProjectMembers(projectName)
      .filter(p => p.userId !== fromUserId && !excludeUserIds.includes(p.userId));

    const ids: string[] = [];
    for (const member of members) {
      const id = this.notifyUser({
        fromUserId,
        targetUserId: member.userId,
        type,
        content,
        payload: { project: projectName },
      });
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Get notifications for a user, newest first. */
  getNotifications(userId: string, unreadOnly = false): UserNotification[] {
    const ids = this.userInbox.get(userId) ?? [];
    const all = ids
      .map(id => this.notifications.get(id))
      .filter((n): n is UserNotification => n !== undefined)
      .reverse(); // newest first
    return unreadOnly ? all.filter(n => !n.readAt) : all;
  }

  /** Mark a notification as read. Returns false if not found. */
  markAsRead(notificationId: string): boolean {
    const n = this.notifications.get(notificationId);
    if (!n) return false;
    n.readAt = new Date();
    return true;
  }

  // --- private ---

  private addToInbox(userId: string, notificationId: string): void {
    if (!this.userInbox.has(userId)) {
      this.userInbox.set(userId, []);
    }
    const inbox = this.userInbox.get(userId)!;
    inbox.push(notificationId);

    if (inbox.length > MAX_INBOX_SIZE) {
      const evicted = inbox.splice(0, inbox.length - MAX_INBOX_SIZE);
      for (const id of evicted) {
        this.notifications.delete(id);
      }
    }
  }
}
