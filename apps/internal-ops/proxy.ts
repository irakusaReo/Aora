import { clerkMiddleware } from '@clerk/nextjs/server';

// Every page needs a Clerk session. Operator rights are AORA's: the API refuses
// every /v1/ops route to anyone without the platform-operator flag.
export default clerkMiddleware(async (auth) => {
  await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
