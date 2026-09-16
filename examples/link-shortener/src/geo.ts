/**
 * The country a visitor came from, asked of a geolocation service outside
 * this system. Stubbed here; `geo-lookup` is what the real one is drawn as.
 */
export function lookupCountry(ip: string): string {
  const first = Number(ip.split(".")[0] ?? "0");
  if (Number.isNaN(first) || first === 0) return "ZZ";
  return first < 64 ? "US" : first < 128 ? "GB" : first < 192 ? "DE" : "JP";
}
