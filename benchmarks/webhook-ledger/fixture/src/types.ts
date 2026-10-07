export type SettlementStatus = 'pending' | 'settled';

export interface EventPayload {
  eventId: string;
  settlementId: string;
  amount: number;
  status: SettlementStatus;
}

export interface Settlement {
  settlementId: string;
  status: SettlementStatus;
  amount: number;
}
