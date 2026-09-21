export type CompatibilityStatus = "unverified" | "readOnlyCompatible" | "compatible" | "incompatible";

export interface ProtocolStatus {
  profileId: string | null;
  status: CompatibilityStatus;
  verifiedAt: string | null;
  message: string;
  queryEnabled: boolean;
  submissionEnabled: boolean;
}

export interface BrowserSessionStatus {
  state: "idle" | "starting" | "awaiting_login" | "logged_in" | "user_action_required" | "closed" | "error";
  message: string;
  updatedAt: string;
}

export interface PassengerSelection {
  passengerRef: string;
  displayName: string;
  ticketType: "adult" | "child" | "student";
  priority: number;
  verified: boolean;
}
export interface OfficialPassenger extends PassengerSelection { ticketTypeLabel: string; officialActive?: boolean; }

export interface RouteGroupInput {
  id: string;
  travelDate: string;
  fromStation: string;
  toStation: string;
  saleTime: string;
  priority: number;
  trainCodes: string[];
  seatTypes: string[];
}

export interface CreateTaskInput {
  name: string;
  priority: number;
  splitAuthorized: boolean;
  realSubmissionAuthorized: boolean;
  passengers: PassengerSelection[];
  routeGroups: RouteGroupInput[];
  deadline: string | null;
}

export interface TicketTaskView {
  id: string;
  name: string;
  priority: number;
  status: string;
  splitAuthorized: boolean;
  realSubmissionAuthorized: boolean;
  passengerCount: number;
  routeGroupCount: number;
  createdAt: string;
  failureReason: string | null;
  deadline: string | null;
}
export interface TicketTaskDetail extends CreateTaskInput {
  id: string;
  status: string;
  createdAt: string;
  failureReason: string | null;
}

export type RehearsalScenario = "seats_available" | "no_availability" | "timeout_reconciled_empty" | "rate_limited";
export interface ExecutionEvent { id: string; taskId: string; source: "SIMULATION" | "12306_OFFICIAL_RUNTIME"; stage: string; outcome: string; message: string; createdAt: string; routeGroupId?: string | null; durationMs?: number | null; }
export interface RehearsalResult { taskId: string; source: "SIMULATION"; finalOutcome: string; events: ExecutionEvent[]; }
export interface TicketQueryCandidate { trainInternalRef: string; trainCode: string; fromStationCode: string; toStationCode: string; departureTime: string; arrivalTime: string; duration: string; canBook: boolean; seats: Record<string, string>; }
export interface TicketQueryResult { source: "12306_OFFICIAL_READ_ONLY"; path: string; status: number; success?: boolean; compatible?: boolean; classification?: string; resultCount?: number; candidates?: TicketQueryCandidate[]; }
export interface OrderSnapshot { localId: string; taskId: string; officialOrderRef: string | null; status: "UNKNOWN" | "PAYMENT_PENDING" | "PAID" | "CANCELLED" | "EXPIRED"; passengerRefs: string[]; paymentDeadline: string | null; lastReconciledAt: string; source: "12306_OFFICIAL"; }
export interface OrderReconciliationResult { source: "12306_OFFICIAL"; classification: "EMPTY" | "PAYMENT_PENDING" | "UNKNOWN_STRUCTURE"; orders?: Array<{ orderRef: string; status: "PAYMENT_PENDING"; passengerRefs: string[]; paymentDeadline: string | null }>; dataKeys?: string[]; }
export interface ScheduledRoute { taskId: string; routeGroupId: string; taskPriority: number; routePriority: number; saleTime: string; travelDate: string; fromStation: string; toStation: string; trainCodes: string[]; seatTypes: string[]; }
export interface BrowserCapabilities { queryEnabled: boolean; realSubmissionEnabled: boolean; }
export interface RealOrderResult { source: "12306_OFFICIAL"; status: "PAYMENT_PENDING" | "QUEUING"; orderRef: string | null; waitTime: number | null; }
