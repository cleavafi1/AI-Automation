import { redirect } from "next/navigation";

// The old throwaway test view has been replaced by the real admin dashboard.
export default function InternalQuotesRedirect() {
  redirect("/admin");
}
