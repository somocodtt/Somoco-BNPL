export interface TrackerLocation {
  readonly latitude: string;
  readonly longitude: string;
  readonly recordedAt: string;
  readonly deviceStatus: "ONLINE" | "OFFLINE" | "UNKNOWN";
}

export interface TrackerPort {
  getLastKnown(input: { trackerId: string }): Promise<TrackerLocation | null>;
}
