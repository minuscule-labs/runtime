const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CodexWorkerIdentity {
  ownerId: string;
  sessionId: string;
  generation: string;
}

/** Private connection material, never a presentation-safe session summary. */
export interface CodexWorkerConnection extends CodexWorkerIdentity {
  version: 1;
  endpoint: string;
  token: string;
  pid: number;
  claimId?: string;
}

export interface CodexWorkerClaim {
  claimId: string;
  pid: number;
}

export function validateWorkerIdentity(identity: CodexWorkerIdentity): void {
  if (!identity || ![identity.ownerId, identity.sessionId, identity.generation]
    .every(value => typeof value === "string" && ID.test(value))) throw new Error("Invalid Codex worker identity");
}

export function validateWorkerConnection(connection: CodexWorkerConnection): void {
  validateWorkerIdentity(connection);
  const endpoint = new URL(connection.endpoint);
  if (connection.version !== 1 || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/"
    || endpoint.search || endpoint.hash || typeof connection.token !== "string" || !/^[a-f0-9]{64}$/.test(connection.token)
    || !Number.isSafeInteger(connection.pid) || connection.pid < 1
    || (connection.claimId !== undefined && (typeof connection.claimId !== "string" || !ID.test(connection.claimId)))
    || Object.keys(connection).some(key => !["version", "ownerId", "sessionId", "generation", "endpoint", "token", "pid", "claimId"].includes(key))) {
    throw new Error("Invalid Codex worker connection");
  }
}
