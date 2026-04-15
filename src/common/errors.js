export class TubeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TubeError';
    this.code = code;
  }
}

export class ConfigError extends TubeError {
  constructor(message) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class AuthError extends TubeError {
  constructor(message) {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class TunnelNotFoundError extends TubeError {
  constructor(tunnelId) {
    super(`Tunnel not found: ${tunnelId}`, 'TUNNEL_NOT_FOUND');
    this.name = 'TunnelNotFoundError';
    this.tunnelId = tunnelId;
  }
}

export class TunnelConflictError extends TubeError {
  constructor(tunnelId, retryAfter) {
    super(`Tunnel subdomain reserved by a different session: ${tunnelId}`, 'TUNNEL_CONFLICT');
    this.name = 'TunnelConflictError';
    this.tunnelId = tunnelId;
    this.retryAfter = retryAfter;
  }
}

export class TunnelUnavailableError extends TubeError {
  constructor(tunnelId, retryAfter) {
    super(`Tunnel temporarily unavailable: ${tunnelId}`, 'TUNNEL_UNAVAILABLE');
    this.name = 'TunnelUnavailableError';
    this.tunnelId = tunnelId;
    this.retryAfter = retryAfter;
  }
}

export class NoPortsAvailableError extends TubeError {
  constructor() {
    super('No available ports in range', 'NO_PORTS_AVAILABLE');
    this.name = 'NoPortsAvailableError';
  }
}

export class TooManyConnectionsError extends TubeError {
  constructor(info = {}) {
    super('Too many tunnel connections', 'TOO_MANY_CONNECTIONS');
    this.name = 'TooManyConnectionsError';
    this.info = info;
  }
}
