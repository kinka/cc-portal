import { createLogger } from '../logger';

const log = createLogger({ module: 'UserDirectory' });

export interface UserProfile {
  userId: string;
  displayName?: string;
  skills?: string[];
  currentProjects?: string[];
  registeredAt: Date;
  lastActiveAt: Date;
}

/**
 * In-memory user directory for profile management and cross-user discovery.
 */
export class UserDirectory {
  private profiles = new Map<string, UserProfile>();

  /** Create or update a user profile. Auto-creates if not exists. */
  upsertProfile(
    userId: string,
    partial: Partial<Omit<UserProfile, 'userId' | 'registeredAt'>> = {},
  ): UserProfile {
    const existing = this.profiles.get(userId);
    if (existing) {
      Object.assign(existing, partial, { lastActiveAt: new Date() });
      return existing;
    }
    const profile: UserProfile = {
      userId,
      registeredAt: new Date(),
      lastActiveAt: new Date(),
      ...partial,
    };
    this.profiles.set(userId, profile);
    log.debug({ userId }, 'User profile created');
    return profile;
  }

  getProfile(userId: string): UserProfile | undefined {
    return this.profiles.get(userId);
  }

  /**
   * Find users by query string.
   * @param by - 'id' matches userId exactly; 'name' matches displayName (case-insensitive);
   *             'auto' tries id first then name.
   */
  findUser(query: string, by: 'name' | 'id' | 'auto' = 'auto'): UserProfile[] {
    const q = query.toLowerCase();

    if (by === 'id') {
      const p = this.profiles.get(query);
      return p ? [p] : [];
    }

    if (by === 'name') {
      return Array.from(this.profiles.values()).filter(p =>
        p.displayName?.toLowerCase().includes(q)
      );
    }

    // auto: exact id match first, then displayName contains
    const exact = this.profiles.get(query);
    if (exact) return [exact];
    return Array.from(this.profiles.values()).filter(p =>
      p.displayName?.toLowerCase().includes(q)
    );
  }

  /** Get all users who have the given project in currentProjects */
  getProjectMembers(projectName: string): UserProfile[] {
    return Array.from(this.profiles.values()).filter(p =>
      p.currentProjects?.includes(projectName)
    );
  }

  /** Update lastActiveAt timestamp for a user */
  touchUser(userId: string): void {
    const p = this.profiles.get(userId);
    if (p) p.lastActiveAt = new Date();
  }
}
