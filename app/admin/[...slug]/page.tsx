import { notFound } from "next/navigation";

/** Unknown admin URLs render the admin not-found state inside the shell (app/admin/not-found.tsx). */
export default function UnknownAdminPage(): never {
  notFound();
}
