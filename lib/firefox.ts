// Typed access to Firefox-only WebExtension APIs, which WXT's Chrome-based typings
// don't include. Only call these behind `import.meta.env.FIREFOX`.

export interface FirefoxCertificate {
  subject: string;
  issuer: string;
  serialNumber: string;
  validity: { start: number; end: number };
  fingerprint: { sha1: string; sha256: string };
  isBuiltInRoot: boolean;
}

export interface FirefoxSecurityInfo {
  state: 'insecure' | 'weak' | 'broken' | 'secure';
  protocolVersion?: string;
  cipherSuite?: string;
  keaGroupName?: string;
  signatureSchemeName?: string;
  certificateTransparencyStatus?: string;
  hsts?: boolean;
  isExtendedValidation?: boolean;
  certificates: FirefoxCertificate[];
}

interface FirefoxApis {
  tabs: {
    captureTab(
      tabId: number,
      options: {
        format?: 'png' | 'jpeg';
        rect?: { x: number; y: number; width: number; height: number };
        scale?: number;
      },
    ): Promise<string>;
  };
  webRequest: {
    getSecurityInfo(
      requestId: string,
      options: { certificateChain?: boolean; rawDER?: boolean },
    ): Promise<FirefoxSecurityInfo>;
  };
  runtime: {
    getBrowserInfo(): Promise<{ name: string; vendor: string; version: string; buildID: string }>;
  };
}

export const firefox = browser as unknown as FirefoxApis;
