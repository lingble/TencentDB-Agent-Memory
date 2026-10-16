/**
 * External knowledge source auth — shared type contracts (resource-level binding).
 *
 * Shared by wiki and codegraph: credentials are attached to the accessed resource (`code_graph_id` / `wiki_id`),
 * not to a person. Design doc: MemoryPanel/docs/design/2026-09-08-external-source-import.md §1.1 / §4.1.
 *
 * Stored in KS; tokens are base64-encoded into `cred_secret` and decoded in memory when used;
 * plaintext never leaves the process (the route layer only returns metadata).
 */

/**
 * Credential shapes:
 *   - `bearer`: a single token (PAT) — the platform protocol provides a placeholder username for basic-auth injection
 *   - `basic`: username + password (username entered by the user)
 *
 * To add a method, first add an implementation in `code-source/auth-methods/`, then add the union member here.
 * No unimplemented members are reserved (to avoid the misleading "looks supported but doesn't actually work").
 */
export type CredentialKind = "bearer" | "basic";

/**
 * Resource reference — the binding unit for credentials.
 * Primary key (service_id, resource_type, resource_id), isomorphic to the credential table PK.
 */
export type ResourceRef =
  | { type: "code-graph"; serviceId: string; resourceId: string }   // resourceId = code_graph_id
  | { type: "wiki"; serviceId: string; resourceId: string };        // resourceId = wiki_id

export type ResourceType = ResourceRef["type"];

export interface SourceCredential {
  kind: CredentialKind;
  /** Long-lived token; the password for basic. */
  secret: string;
  /** Username for basic auth (entered by the user); fixed by the source for PAT types (see CLONE_USERNAME). */
  username?: string;
  /** Protocol-specific fields (mcp_url / corpid / header name). */
  extra?: Record<string, unknown>;
}

/** Credential metadata (never contains plaintext). */
export interface CredentialStatus {
  resource_type: ResourceType;
  resource_id: string;
  provider_id: string;
  cred_kind: CredentialKind;
  last_verified_at: string | null;
  updated_at: string;
}

/** Resource-level credential store. */
export interface ICredentialStore {
  /** Get the plaintext credential (only used inside the KS process). Not configured / decode failure → null (does not throw). */
  get(ref: ResourceRef): SourceCredential | null;
  /** provider_id records the protocol source ('gongfeng' / 'iwiki', etc.); not a key, for display only. */
  put(ref: ResourceRef, cred: SourceCredential, providerId: string, updatedBy?: string): void;
  delete(ref: ResourceRef): boolean;
  /** Metadata only; never returns the secret. */
  status(ref: ResourceRef): CredentialStatus | null;
  /**
   * List all credential rows of a resource type across **all services** (id + service only, for the background scheduler scan).
   * Internal KS method, not exposed as an HTTP endpoint (cross-resource enumeration would widen the privilege-escalation surface).
   */
  listAllByType(type: ResourceType): Array<{ serviceId: string; resourceId: string }>;
  /** Record a verification result (only updates the timestamp). */
  recordVerify(ref: ResourceRef): void;
}

/** Encoded row (persisted shape). */
export interface CredentialRow {
  service_id: string;
  resource_type: ResourceType;
  resource_id: string;
  provider_id: string;
  cred_kind: CredentialKind;
  cred_secret: string;                // base64
  cred_username: string | null;       // basic only
  cred_extra_json: string | null;
  last_verified_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
