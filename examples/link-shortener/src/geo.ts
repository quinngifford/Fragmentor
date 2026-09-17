/**
 * Which country a visitor came from.
 *
 * This is a stand-in: it reads the country off the address rather than asking
 * anyone. The real geolocation service is drawn on the diagram as a planned
 * block, because nothing here calls one yet.
 */
export function lookupCountry(ip: string): string {
  const first = Number(ip.split(".")[0] ?? "0");
  if (Number.isNaN(first) || first === 0) return "ZZ";
  return first < 64 ? "US" : first < 128 ? "GB" : first < 192 ? "DE" : "JP";
}
