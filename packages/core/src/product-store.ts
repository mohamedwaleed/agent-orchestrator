export interface Product {
  id: number;
  name: string;
  price: number;
}

/** In-memory product catalog exposed by the HTTP API. */
export const products: Product[] = [
  { id: 1, name: "Laptop", price: 999.99 },
  { id: 2, name: "Headphones", price: 149.99 },
  { id: 3, name: "Keyboard", price: 79.99 },
];
