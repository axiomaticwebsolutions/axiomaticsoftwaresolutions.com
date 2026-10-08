/**
 * SAMPLE people: staff (admin seed), the "Sharma Medicals" customer workspace (portal + enterprise seed) and the
 * 14 admin sample customers. Only the env owner and the demo logins (docs/decisions.md 9 and Phase 5) get passwords;
 * everyone else has passwordHash null and cannot sign in. All addresses use the reserved .example domain.
 */
import { StaffRole, StaffStatus, TeamRole } from "@/generated/prisma/enums";
import type { IndianState } from "@/lib/validation/states";

/** Where a seeded user's password comes from. Values are read from env by prisma/seed.ts, never stored here. */
export type PasswordSource = "owner" | "demo" | null;

export type SeedStaff = {
  key: string;
  name: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
  twoStepEnabled: boolean;
  password: PasswordSource;
  /** Days before the run; null = never active (invited). */
  lastActiveAgoDays: number | null;
};

/**
 * Admin seed staff s1-s6 (lastActive ago(i * 0.7)). Every active seeded staff member has two-step on (codes appear at
 * /dev/mailbox), so the dev checks exercise the code step; it is optional per person, never forced by role
 * (decisions.md 2026-10-08). Vikram, Sneha and Karan share SEED_DEMO_PASSWORD.
 */
export const SAMPLE_STAFF: readonly SeedStaff[] = [
  { key: "anita", name: "Anita Desai", email: "anita@axiomatic.example", role: StaffRole.OWNER, status: StaffStatus.ACTIVE, twoStepEnabled: true, password: null, lastActiveAgoDays: 0 },
  { key: "vikram", name: "Vikram Rao", email: "vikram@axiomatic.example", role: StaffRole.ADMIN, status: StaffStatus.ACTIVE, twoStepEnabled: true, password: "demo", lastActiveAgoDays: 0.7 },
  { key: "sneha", name: "Sneha Patil", email: "sneha@axiomatic.example", role: StaffRole.SUPPORT, status: StaffStatus.ACTIVE, twoStepEnabled: true, password: "demo", lastActiveAgoDays: 1.4 },
  { key: "rahul", name: "Rahul Nair", email: "rahul@axiomatic.example", role: StaffRole.SUPPORT, status: StaffStatus.ACTIVE, twoStepEnabled: true, password: null, lastActiveAgoDays: 2.1 },
  { key: "karan", name: "Karan Mehta", email: "karan@axiomatic.example", role: StaffRole.FINANCE, status: StaffStatus.ACTIVE, twoStepEnabled: true, password: "demo", lastActiveAgoDays: 2.8 },
  { key: "priyanka", name: "", email: "priyanka@axiomatic.example", role: StaffRole.SUPPORT, status: StaffStatus.INVITED, twoStepEnabled: false, password: null, lastActiveAgoDays: null },
];

/** The real Owner login comes from SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD. */
export const OWNER_NAME = "Site owner";

export type SeedMember = {
  key: string;
  name: string;
  email: string;
  phone: string | null;
  role: TeamRole;
  invited: boolean;
  password: PasswordSource;
  lastActiveAgoDays: number | null;
  /** Days before the run the user was created (or invited). */
  createdAgoDays: number;
};

export const SHARMA_ACCOUNT = {
  key: "sharma",
  legalName: "Sharma Medicals",
  gstin: "27ABCDE1234F1Z5",
  address: "Shop 4, FC Road",
  city: "Pune",
  state: "Maharashtra" as IndianState,
  pin: "411004",
  createdAgoDays: 561,
} as const;

/**
 * Enterprise seed team m1-m4. Priya (Owner), Rohan (Billing admin) and Kavya (Technical contact) sign in with
 * SEED_DEMO_PASSWORD (decisions.md Phase 5: role-based portal behaviour can be checked locally). The invited viewer has
 * no name yet and cannot sign in.
 */
export const SHARMA_MEMBERS: readonly SeedMember[] = [
  { key: "priya", name: "Priya Sharma", email: "priya@sharmamedicals.example", phone: "9820000000", role: TeamRole.OWNER, invited: false, password: "demo", lastActiveAgoDays: 0, createdAgoDays: 561 },
  { key: "rohan", name: "Rohan Sharma", email: "rohan@sharmamedicals.example", phone: null, role: TeamRole.BILLING, invited: false, password: "demo", lastActiveAgoDays: 2, createdAgoDays: 400 },
  { key: "kavya", name: "Kavya Desai", email: "kavya@sharmamedicals.example", phone: null, role: TeamRole.TECHNICAL, invited: false, password: "demo", lastActiveAgoDays: 6, createdAgoDays: 300 },
  { key: "joshica", name: "", email: "accounts@joshica.example", phone: null, role: TeamRole.VIEWER, invited: true, password: null, lastActiveAgoDays: null, createdAgoDays: 3 },
];

export const SHARMA_LOCATIONS = [
  { key: "loc1", name: "FC Road (main store)" },
  { key: "loc2", name: "Kothrud branch" },
] as const;

export type SeedCustomer = {
  name: string;
  business: string;
  city: string;
  state: IndianState;
  gstin: string | null;
  /** City head post office PIN: the prototype has no address, so the billing address is a labelled placeholder. */
  pin: string;
};

/** Admin seed array C, in order (the PRNG picks customers by index). */
export const SAMPLE_CUSTOMERS: readonly SeedCustomer[] = [
  { name: "Arjun Menon", business: "Spice Route Kitchen", city: "Kochi", state: "Kerala", gstin: null, pin: "682001" },
  { name: "Fatima Khan", business: "Khan General Store", city: "Hyderabad", state: "Telangana", gstin: "36ABCDE5678G1Z2", pin: "500001" },
  { name: "Rohit Verma", business: "Verma Traders", city: "New Delhi", state: "Delhi", gstin: "07ABCDE9012H1Z8", pin: "110001" },
  { name: "Meera Iyer", business: "Iyer Pharmacy", city: "Chennai", state: "Tamil Nadu", gstin: null, pin: "600001" },
  { name: "Gurpreet Singh", business: "Punjab Rasoi", city: "Ludhiana", state: "Punjab", gstin: null, pin: "141001" },
  { name: "Ananya Rao", business: "Rao Departmental Store", city: "Bengaluru", state: "Karnataka", gstin: "29ABCDE3456J1Z4", pin: "560001" },
  { name: "Imran Sheikh", business: "City Chemists", city: "Ahmedabad", state: "Gujarat", gstin: "24ABCDE7890K1Z6", pin: "380001" },
  { name: "Kavita Joshi", business: "Joshi & Sons Hardware", city: "Jaipur", state: "Rajasthan", gstin: null, pin: "302001" },
  { name: "Sanjay Patel", business: "Patel Kirana", city: "Surat", state: "Gujarat", gstin: null, pin: "395003" },
  { name: "Deepa Nair", business: "Cafe Monsoon", city: "Thiruvananthapuram", state: "Kerala", gstin: null, pin: "695001" },
  { name: "Vivek Gupta", business: "Gupta Accounts Office", city: "Lucknow", state: "Uttar Pradesh", gstin: "09ABCDE2345L1Z1", pin: "226001" },
  { name: "Nisha Kulkarni", business: "Kulkarni Medicals", city: "Nashik", state: "Maharashtra", gstin: "27ABCDE6789M1Z3", pin: "422001" },
  { name: "Abdul Rahman", business: "Rahman Bakery & Cafe", city: "Bhopal", state: "Madhya Pradesh", gstin: null, pin: "462001" },
  { name: "Sneha Banerjee", business: "Banerjee Stores", city: "Kolkata", state: "West Bengal", gstin: "19ABCDE1122N1Z7", pin: "700001" },
];

/** Prototype pattern: first name + "@" + business letters only + ".example" (arjun@spiceroutekitchen.example). */
export function customerEmail(customer: Pick<SeedCustomer, "name" | "business">): string {
  const first = (customer.name.split(" ")[0] ?? customer.name).toLowerCase();
  return `${first}@${customer.business.toLowerCase().replace(/[^a-z]+/g, "")}.example`;
}

/** Obviously fake but well-formed mobile numbers for billing snapshots (the prototype has none). */
export function customerPhone(index: number): string {
  return `90000${String(index).padStart(5, "0")}`;
}

/** Placeholder billing address for a sample customer. */
export function customerAddress(customer: Pick<SeedCustomer, "city">): string {
  return `Sample address, ${customer.city}`;
}
