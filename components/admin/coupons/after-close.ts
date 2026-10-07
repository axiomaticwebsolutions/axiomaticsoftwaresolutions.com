/**
 * Closes a drawer, then runs `then` (usually router.refresh()) once the URL change has been applied. Closing usually
 * steps back in history; a refresh started before the popstate would be replaced by the restored (stale) page, so
 * it waits for that event, or a short moment when closing only replaced the URL. Browser only.
 */
export function afterDrawerClose(close: () => void, then: () => void, fallbackMs = 250): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener("popstate", finish);
    window.setTimeout(then, 0);
  };
  window.addEventListener("popstate", finish);
  close();
  window.setTimeout(finish, fallbackMs);
}
