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
  /** Localização atual (último evento de scan). */
  location: string | null;
  /** Origem do envio (cidade/UF/país), quando a transportadora informa. */
  origin: string | null;
  /** Destino final da entrega (cidade/UF/país), quando a transportadora informa. */
  destination: string | null;
  estimatedDelivery: string | null;
  events: TrackingEvent[];
  error: string | null;
}
