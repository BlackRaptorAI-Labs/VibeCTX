import type { WriteStream } from "node:tty";

const restorations: (() => void)[] = [];
/** Exercise the real process stream, including hosts where isTTY is absent. */
export function stubTerminal(stream: WriteStream, isTTY: boolean | undefined): void {
  const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY });
  restorations.push(() => {
    if (previous) Object.defineProperty(stream, "isTTY", previous);
    else Reflect.deleteProperty(stream, "isTTY");
  });
}
export function restoreTerminals(): void {
  for (const restore of restorations.splice(0).reverse()) restore();
}
