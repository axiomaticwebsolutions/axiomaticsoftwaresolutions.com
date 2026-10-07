/**
 * Deterministic primary keys for every seeded row that would otherwise get a cuid, so the seed can upsert and a
 * second run touches the same rows. Human ids (AX-, LIC-, T-) and slugs are already deterministic.
 */
export const SEED_ID_PREFIX = "seed_";

export const seedIds = {
  user: (key: string) => `seed_user_${key}`,
  account: (key: string) => `seed_acct_${key}`,
  member: (accountKey: string, userKey: string) => `seed_mem_${accountKey}_${userKey}`,
  inviteToken: (accountKey: string, userKey: string) => `seed_invite_${accountKey}_${userKey}`,
  location: (key: string) => `seed_loc_${key}`,
  device: (key: string) => `seed_dev_${key}`,
  licenseEvent: (licenseId: string, n: number) => `seed_levt_${licenseId}_${n}`,
  orderItem: (orderId: string, n: number) => `seed_item_${orderId}_${n}`,
  payment: (orderId: string) => `seed_pay_${orderId}`,
  invoice: (orderId: string) => `seed_inv_${orderId}`,
  refund: (orderId: string) => `seed_refund_${orderId}`,
  redemption: (orderId: string) => `seed_redeem_${orderId}`,
  ticketMessage: (ticketId: string, n: number) => `seed_msg_${ticketId}_${n}`,
  notification: (key: string) => `seed_ntf_${key}`,
  activity: (n: number) => `seed_act_${n}`,
  faq: (page: string, n: number) => `seed_faq_${page}_${n}`,
  release: (productId: string, version: string) => `seed_rel_${productId}_${version}`,
  releaseFile: (productId: string, version: string, platform: string) => `seed_file_${productId}_${version}_${platform}`,
  audit: (n: number) => `seed_audit_${n}`,
  webhookDelivery: (n: number) => `seed_whd_${n}`,
} as const;

/** "AX-10198" -> "10198", for sample provider references such as "order_SAMPLE_10198". */
export function orderNumber(orderId: string): string {
  return orderId.replace(/^AX-/, "");
}
