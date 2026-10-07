import { notFound } from "next/navigation";

/** Unknown portal URLs render the portal's not-found state inside the shell (app/account/not-found.tsx). */
export default function UnknownAccountPage(): never {
  notFound();
}
