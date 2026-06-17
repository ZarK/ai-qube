export function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(['"])([\s\S]*?)\2/gu)) {
    const key = match[1];
    const attributeValue = match[3];
    if (key === undefined || attributeValue === undefined) {
      continue;
    }

    attributes[key] = decodeXmlEntities(attributeValue);
  }

  return attributes;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

export function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/gu, "");
}
