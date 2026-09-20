/**
 * Momento del día y lugar del usuario, para el encabezado del CRM.
 *
 * Todo se calcula con la hora y la zona horaria DEL DISPOSITIVO de quien está conectado, no con la
 * del negocio: si la CEO administra desde Tijuana un negocio con horario de Monterrey, su encabezado
 * dice Tijuana. Son cosas distintas y no deben confundirse.
 */

export type Franja = "manana" | "mediodia" | "tarde" | "noche";

/**
 * Franja según la hora local (0–23).
 *
 *   05:00–11:59 mañana · 12:00–13:59 mediodía · 14:00–18:59 tarde · 19:00–04:59 noche
 *
 * El mediodía existe como franja VISUAL (el sol alto) pero saluda "buenas tardes", que es lo que
 * dice la gente: nadie saluda "buen mediodía".
 */
export function franjaDe(hora: number): Franja {
  if (hora >= 5 && hora < 12) return "manana";
  if (hora >= 12 && hora < 14) return "mediodia";
  if (hora >= 14 && hora < 19) return "tarde";
  return "noche";
}

export function saludoDe(franja: Franja): string {
  return franja === "manana"
    ? "Buenos días"
    : franja === "noche"
      ? "Buenas noches"
      : "Buenas tardes";
}

/** Saludo completo con el nombre de pila de quien esté conectado. */
export function saludoPara(nombre: string, hora: number): string {
  const pila = nombre.trim().split(/\s+/)[0] ?? nombre;
  return `${saludoDe(franjaDe(hora))}, ${pila}`;
}

export type Lugar = { ciudad: string; pais: string } | null;

/**
 * Ciudad y país a partir de la ZONA HORARIA del dispositivo (`America/Tijuana` → Tijuana, México).
 *
 * Por qué así y no por geolocalización: la zona horaria ya la da el navegador, no pide permiso, no
 * manda coordenadas a nadie y acierta en lo que aquí importa (dónde está trabajando la persona).
 * Pedir la ubicación precisa para escribir "Tijuana" sería desproporcionado, y además obligaría a
 * mandar las coordenadas a un servicio externo para traducirlas a un nombre.
 *
 * Si la zona no se reconoce, se devuelve `null` y el encabezado lo dice en vez de inventar un lugar.
 */
const CIUDADES: Record<string, { ciudad: string; pais: string }> = {
  "America/Tijuana": { ciudad: "Tijuana", pais: "México" },
  "America/Mexico_City": { ciudad: "Ciudad de México", pais: "México" },
  "America/Monterrey": { ciudad: "Monterrey", pais: "México" },
  "America/Hermosillo": { ciudad: "Hermosillo", pais: "México" },
  "America/Mazatlan": { ciudad: "Mazatlán", pais: "México" },
  "America/Chihuahua": { ciudad: "Chihuahua", pais: "México" },
  "America/Cancun": { ciudad: "Cancún", pais: "México" },
  "America/Merida": { ciudad: "Mérida", pais: "México" },
  "America/Matamoros": { ciudad: "Matamoros", pais: "México" },
  "America/Ojinaga": { ciudad: "Ojinaga", pais: "México" },
  "America/Bahia_Banderas": { ciudad: "Bahía de Banderas", pais: "México" },
  "America/Los_Angeles": { ciudad: "Los Ángeles", pais: "Estados Unidos" },
  "America/Denver": { ciudad: "Denver", pais: "Estados Unidos" },
  "America/Phoenix": { ciudad: "Phoenix", pais: "Estados Unidos" },
  "America/Chicago": { ciudad: "Chicago", pais: "Estados Unidos" },
  "America/New_York": { ciudad: "Nueva York", pais: "Estados Unidos" },
  "America/Bogota": { ciudad: "Bogotá", pais: "Colombia" },
  "America/Lima": { ciudad: "Lima", pais: "Perú" },
  "America/Santiago": { ciudad: "Santiago", pais: "Chile" },
  "America/Argentina/Buenos_Aires": { ciudad: "Buenos Aires", pais: "Argentina" },
  "America/Guatemala": { ciudad: "Guatemala", pais: "Guatemala" },
  "America/Costa_Rica": { ciudad: "San José", pais: "Costa Rica" },
  "America/Panama": { ciudad: "Panamá", pais: "Panamá" },
  "America/Toronto": { ciudad: "Toronto", pais: "Canadá" },
  "Europe/Madrid": { ciudad: "Madrid", pais: "España" },
};

/** Países de las zonas no listadas, para no quedarnos con la ciudad sola. */
const PAISES_POR_PREFIJO: Array<[RegExp, string]> = [
  [/^America\/Argentina\//, "Argentina"],
  [
    /^America\/(Cancun|Merida|Monterrey|Mexico_City|Tijuana|Hermosillo|Mazatlan|Chihuahua)/,
    "México",
  ],
  [/^Europe\//, "Europa"],
  [/^Asia\//, "Asia"],
  [/^Africa\//, "África"],
  [/^Australia\//, "Australia"],
  [/^Pacific\//, "Oceanía"],
];

export function lugarDeZonaHoraria(zona: string | null | undefined): Lugar {
  if (!zona) return null;
  const conocido = CIUDADES[zona];
  if (conocido) return conocido;
  // Zona no listada: se usa el nombre de la ciudad que trae la propia zona (`Europe/Lisbon` →
  // Lisbon) antes que no decir nada. Es dato real del dispositivo, no una suposición.
  const partes = zona.split("/");
  const ultima = partes.at(-1);
  if (!ultima || partes.length < 2) return null;
  const ciudad = ultima.replace(/_/g, " ");
  const pais = PAISES_POR_PREFIJO.find(([re]) => re.test(zona))?.[1] ?? "";
  return { ciudad, pais };
}

/** "Tijuana, México" · "Lisbon" · null si no se pudo saber. */
export function lugarLegible(lugar: Lugar): string | null {
  if (!lugar) return null;
  return lugar.pais ? `${lugar.ciudad}, ${lugar.pais}` : lugar.ciudad;
}
