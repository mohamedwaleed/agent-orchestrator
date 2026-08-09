export interface User {
  id: number;
  name: string;
  email: string;
}

/** In-memory users exposed by the HTTP API. */
export const users: User[] = [
  { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
  { id: 2, name: "Grace Hopper", email: "grace@example.com" },
  { id: 3, name: "Alan Turing", email: "alan@example.com" },
];
