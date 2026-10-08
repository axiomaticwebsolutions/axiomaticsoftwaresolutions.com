/**
 * Curated Material Symbols Rounded names (opsz 24, wght 400, FILL 0) used by the app.
 * Union of every icon in the prototypes (store, purchase/auth, portal, admin), prototype/axiomatic-data.js and the
 * admin module icons, plus a few that the UI primitives need (warning, more_horiz, more_vert, keyboard_command_key).
 * Keep sorted and deduplicated. After editing, run `pnpm icons` to regenerate components/icons/registry.ts.
 */
export const ICON_NAMES = [
  "account_balance", "account_balance_wallet", "add", "add_to_queue", "all_inclusive", "apartment", "archive",
  "arrow_back", "arrow_downward", "arrow_forward", "arrow_upward", "article", "attach_file", "autorenew", "badge",
  "bar_chart", "barcode_scanner", "block", "border_color", "build_circle", "call", "call_split", "cancel", "check",
  "check_circle", "chevron_left", "chevron_right", "clinical_notes", "close", "cloud", "compare_arrows", "computer",
  "confirmation_number", "contact_mail", "contacts", "content_copy", "create_new_folder", "credit_card", "currency_exchange",
  "database", "delete", "description", "desktop_windows", "devices", "done_all", "download", "edit_document", "error",
  "event", "event_busy", "event_repeat", "event_upcoming", "expand_less", "expand_more", "gavel", "group",
  "handshake", "help", "history", "hourglass_top", "info", "inventory", "inventory_2", "key", "keyboard_command_key",
  "laptop", "laptop_mac", "local_pharmacy", "local_shipping", "lock", "lock_reset", "logout", "mail", "manage_search",
  "mark_chat_unread", "mark_email_unread", "medication", "menu", "menu_book", "monitoring", "more_horiz", "more_time",
  "more_vert", "new_releases", "notifications", "open_in_new", "outgoing_mail", "palette", "pause", "pause_circle", "payments",
  "pending", "pending_actions", "percent", "person", "person_add", "person_off", "phone_android", "play_arrow",
  "play_circle", "policy", "print", "publish", "qr_code_2", "radio_button_unchecked", "receipt_long", "remove",
  "restart_alt", "restaurant", "rocket_launch", "room_service", "schedule", "search", "search_off", "sell", "send",
  "settings", "shield", "shield_person", "shopping_bag", "shopping_basket", "shopping_cart_checkout", "smartphone",
  "space_dashboard", "storefront", "summarize", "support_agent", "swap_horiz", "table_restaurant", "target",
  "task_alt", "timer", "toggle_on", "translate", "trending_down", "tune", "undo", "unfold_more", "update", "upload",
  "verified", "verified_user", "visibility", "visibility_off", "warning", "webhook", "wifi_off",
] as const;

export type IconSourceName = (typeof ICON_NAMES)[number];

/**
 * Names the prototypes use (icon-font ligatures) that the SVG package publishes under a newer name.
 * The registry keeps the prototype name as the key so markup can use the names from the handoff.
 */
export const ICON_ALIASES: Partial<Record<IconSourceName, string>> = {
  expand_less: "keyboard_arrow_up",
  expand_more: "keyboard_arrow_down",
  laptop: "laptop_windows",
  new_releases: "release_alert",
  phone_android: "mobile",
  smartphone: "mobile",
};
