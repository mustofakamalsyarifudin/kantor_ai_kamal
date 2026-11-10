import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      email: string;
      name: string;
      workspaceId: string;
    };
    user: {
      sub: string;
      email: string;
      name: string;
      workspaceId: string;
    };
  }
}
