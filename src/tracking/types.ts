/** Formato normalizado de rastreio, comum a todas as transportadoras. */
export interface TrackingEvent {
  time: string;
  description: string;
  location: string | null;
}

export interface TrackingResult {
  trackingNumber: string;
  carrier: string;
  found: boolean;
  status: string | null;
  statusCode: string | null;
  location: string | null;
  estimatedDelivery: string | null;
  events: TrackingEvent[];
  error: string | null;
}
