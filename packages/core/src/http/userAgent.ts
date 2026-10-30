import { USER_AGENT_PREFIX } from '../types';

export const CORE_VERSION = '0.1.0';
export const DEFAULT_USER_AGENT = `${USER_AGENT_PREFIX}/${CORE_VERSION}`;

export function buildUserAgent(version: string = CORE_VERSION, extra?: string): string {
  const base = `${USER_AGENT_PREFIX}/${version}`;
  return extra ? `${base} (${extra})` : base;
}

export const UserAgent = {
  DEFAULT: DEFAULT_USER_AGENT,
  build: buildUserAgent,
} as const;
