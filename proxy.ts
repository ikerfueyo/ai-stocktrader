import { clerkMiddleware } from "@clerk/nextjs/server";

// Makes the Clerk session available to pages and route handlers. Route handlers reject signed-out requests themselves (withUser),
// and pages show the sign-in form in their place (components/AppShell.tsx).
export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
