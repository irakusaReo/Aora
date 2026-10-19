import { clerkMiddleware } from '@clerk/nextjs/server';

// Makes the session available. Protection is checked where data is used (each
// page asks for the session before calling the API), and the API checks the
// token again and applies AORA's own roles (ADR 0019).
export default clerkMiddleware();

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
