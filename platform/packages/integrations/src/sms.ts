export interface SmsPort {
  send(input: {
    idempotencyKey: string;
    phoneE164: string;
    template: string;
    variables: Readonly<Record<string, string>>;
  }): Promise<{ providerReference: string; acceptedAt: string }>;
}
