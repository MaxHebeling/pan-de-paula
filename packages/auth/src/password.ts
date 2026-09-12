import { hash, verify } from "@node-rs/argon2";

// Parámetros OWASP (argon2id): 19 MiB, 2 iteraciones, 1 hilo.
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(plain: string): Promise<string> {
  validatePasswordPolicy(plain);
  return hash(plain, OPTS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(plain: string): void {
  if (typeof plain !== "string" || plain.length < 10)
    throw new Error("La contraseña debe tener al menos 10 caracteres");
  if (plain.length > 128) throw new Error("La contraseña es demasiado larga");
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain))
    throw new Error("La contraseña debe combinar letras y números");
}

/** PIN de 4–6 dígitos para POS (se guarda con argon2 igual que la contraseña). */
export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("El PIN debe tener de 4 a 6 dígitos");
  return hash(pin, OPTS);
}
