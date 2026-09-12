import type { Entity, EntityHandler } from "../types.ts";
import { customers } from "./customers.ts";
import { ingredients } from "./ingredients.ts";
import { orders } from "./orders.ts";
import { prices } from "./prices.ts";
import { products } from "./products.ts";
import { recipes } from "./recipes.ts";

export const HANDLERS: Record<Entity, EntityHandler> = {
  ingredients,
  products,
  recipes,
  customers,
  prices,
  orders,
};
