"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  useCommandShortcut,
} from "@/components/ui/command";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Toaster, toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Demo, DemoGrid } from "@/app/dev/ui/section";

const LICENSE_ID = "LIC-24017";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Dialogs, drawers, menus, tooltips, the command palette and toasts, all live. */
export function OverlayDemos() {
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [suspendOpen, setSuspendOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [toastPosition, setToastPosition] = React.useState<"bottom-right" | "bottom-center">("bottom-right");
  const [showArchived, setShowArchived] = React.useState(false);

  useCommandShortcut(() => setPaletteOpen((open) => !open));

  return (
    <DemoGrid>
      <Demo title="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a team member</DialogTitle>
              <DialogDescription>They get an email with a link to join this business account.</DialogDescription>
            </DialogHeader>
            <p className="text-[14.5px] text-ink-body">
              Focus is trapped inside; Escape, the close button and the scrim close the dialog, and focus returns to
              the button that opened it.
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Send invite</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Demo>

      <Demo title="Alert dialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive-outline">Sign out of all devices</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
              <AlertDialogDescription>
                Every other session ends now. You stay signed in on this device.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => toast.success("Signed out of other sessions")}>
                Sign out
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Demo>

      <Demo title="Confirm dialog (reason + typed ID)">
        <div className="flex flex-wrap gap-3">
          <Button variant="destructive" size="sm" onClick={() => setRevokeOpen(true)}>
            <Icon name="block" size={18} />
            Revoke
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setSuspendOpen(true)}>
            <Icon name="pause_circle" size={18} />
            Suspend
          </Button>
        </div>
        <p className="text-[13px] text-ink-2">
          Confirm stays disabled until the reason has 4+ characters and the ID matches. The demo action waits 1.2s.
        </p>
        <ConfirmDialog
          open={revokeOpen}
          onOpenChange={setRevokeOpen}
          tone="danger"
          icon="block"
          title={`Revoke ${LICENSE_ID} permanently?`}
          description="The key stops working on every device and can’t be reinstated. Use for fraud or refunds only."
          confirmLabel="Revoke license"
          confirmText={LICENSE_ID}
          onConfirm={async ({ reason }) => {
            await wait(1200);
            toast.success("License revoked", { description: `Reason: ${reason}` });
          }}
        />
        <ConfirmDialog
          open={suspendOpen}
          onOpenChange={setSuspendOpen}
          tone="warning"
          icon="pause_circle"
          title={`Suspend ${LICENSE_ID}?`}
          description="Installed copies will fail their next validation check (within the 7-day offline grace period). You can reinstate later."
          confirmLabel="Suspend"
          onConfirm={async () => {
            await wait(800);
            throw new Error("Couldn’t reach the server. Nothing was changed.");
          }}
        />
      </Demo>

      <Demo title="Sheet (drawers)">
        <div className="flex flex-wrap gap-3">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">Open 560px drawer</Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <p className="text-overline uppercase text-ink-2">License</p>
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle className="font-mono">{LICENSE_ID}</SheetTitle>
                  <Badge tone="sage" size="sm">
                    Active
                  </Badge>
                </div>
                <SheetDescription>Medical Store Billing · Annual · 2 of 3 devices</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
                  {[
                    ["Key", "MED-••••-••••-••••-K8NM"],
                    ["Customer", "priya@example.com"],
                    ["Issued", "12 Sep 2026"],
                    ["Expires", "12 Sep 2027"],
                  ].map(([term, value]) => (
                    <div key={term} className="grid gap-0.5">
                      <dt className="text-[11.5px] font-extrabold uppercase tracking-[0.07em] text-ink-2">{term}</dt>
                      <dd className={term === "Key" ? "font-mono" : undefined}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </SheetBody>
              <SheetFooter>
                <Button size="sm" variant="secondary" onClick={() => setSuspendOpen(true)}>
                  Suspend
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setRevokeOpen(true)}>
                  Revoke
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">
                <Icon name="menu" size={20} />
                Left drawer
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Menu</SheetTitle>
                <SheetDescription>Mobile navigation and the portal sidebar use this side.</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <nav aria-label="Demo" className="grid gap-1 text-[15px] font-semibold">
                  {["Overview", "Licenses", "Devices", "Orders", "Support"].map((item, index) => (
                    <a
                      key={item}
                      href="#overlays"
                      aria-current={index === 0 ? "page" : undefined}
                      className="rounded-10 px-3 py-2.5 hover:bg-lavender-bg aria-[current=page]:bg-lavender-bg aria-[current=page]:text-lavender-fg"
                    >
                      {item}
                    </a>
                  ))}
                </nav>
              </SheetBody>
            </SheetContent>
          </Sheet>
        </div>
      </Demo>

      <Demo title="Dropdown menu and popover">
        <div className="flex flex-wrap gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">
                Actions
                <Icon name="expand_more" size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>License</DropdownMenuLabel>
              <DropdownMenuItem>
                <Icon name="content_copy" size={18} />
                Copy license ID
                <DropdownMenuShortcut>Ctrl C</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon name="download" size={18} />
                Download installer
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Icon name="more_time" size={18} />
                Extend 30 days
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem checked={showArchived} onCheckedChange={(value) => setShowArchived(value)}>
                Show archived
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setRevokeOpen(true)}>
                <Icon name="block" size={18} />
                Revoke…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary">
                <Icon name="storefront" size={18} />
                Sharma Medical
                <Icon name="unfold_more" size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-overline uppercase text-ink-2">Switch business</p>
              <ul className="mt-2 grid gap-1 text-[14px] font-semibold">
                <li className="rounded-8 bg-lavender-bg px-2.5 py-2 text-lavender-fg">Sharma Medical · Pune</li>
                <li className="px-2.5 py-2">Sharma Medical · Mumbai</li>
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      </Demo>

      <Demo title="Tooltip">
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="secondary" aria-label="Help">
                <Icon name="help" size={20} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Help and documentation</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* aria-disabled (not disabled) keeps the button focusable and hoverable, so the reason is reachable. */}
              <Button
                size="sm"
                variant="destructive-outline"
                aria-disabled="true"
                onClick={(event) => event.preventDefault()}
              >
                <Icon name="currency_exchange" size={18} />
                Issue refund
              </Button>
            </TooltipTrigger>
            <TooltipContent>Requires Owner / Administrator / Finance</TooltipContent>
          </Tooltip>
        </div>
      </Demo>

      <Demo title="Command palette">
        <Button variant="secondary" className="justify-between" onClick={() => setPaletteOpen(true)}>
          <span className="inline-flex items-center gap-2 text-ink-2">
            <Icon name="search" size={18} />
            Search
          </span>
          <span className="inline-flex gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
          <CommandInput placeholder="Search licenses, devices, orders, tickets" />
          <CommandList>
            <CommandEmpty>No results. Try a license ID or the last 4 characters of a key.</CommandEmpty>
            <CommandGroup heading="Licenses">
              <CommandItem value="LIC-24017 Medical Store Billing K8NM" onSelect={() => setPaletteOpen(false)}>
                <Icon name="key" size={18} />
                <span className="font-mono">{LICENSE_ID}</span> Medical Store Billing
                <CommandShortcut>K8NM</CommandShortcut>
              </CommandItem>
              <CommandItem value="LIC-24009 Restaurant Billing" onSelect={() => setPaletteOpen(false)}>
                <Icon name="key" size={18} />
                <span className="font-mono">LIC-24009</span> Restaurant Billing
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Orders">
              <CommandItem value="AX-10421 order" onSelect={() => setPaletteOpen(false)}>
                <Icon name="receipt_long" size={18} />
                <span className="font-mono">AX-10421</span> Paid
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </Demo>

      <Demo title="Toasts">
        <SegmentedControl
          aria-label="Toast position"
          variant="chip"
          value={toastPosition}
          onValueChange={setToastPosition}
          options={[
            { value: "bottom-right", label: "Bottom right (portal, admin)" },
            { value: "bottom-center", label: "Bottom center (store)" },
          ]}
        />
        <div className="flex flex-wrap gap-3">
          <Button variant="dark" onClick={() => toast.success("Saved")}>
            Success toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.success("Added to cart", {
                description: "Medical Store Billing · Annual",
                action: { label: "View cart", onClick: () => undefined },
                cancel: { label: "Keep browsing", onClick: () => undefined },
              })
            }
          >
            With actions
          </Button>
          <Button variant="secondary" onClick={() => toast.error("Payment failed. No money was taken.")}>
            Error toast
          </Button>
        </div>
        <Toaster position={toastPosition} />
      </Demo>
    </DemoGrid>
  );
}
