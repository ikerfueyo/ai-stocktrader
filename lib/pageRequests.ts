import axios, { type InternalAxiosRequestConfig } from "axios";

// The page's own data requests (GETs) are cancelled when the app navigates to another page. Browsers open at most 6 HTTP/1.1
// connections to the server, and a page such as Trading starts about a dozen requests, some slow (an analysis, prices queued behind
// Alpha Vantage's rate limit); the next page's own request (Next.js's RSC fetch) would queue behind them, so a click on a ticker
// waited seconds while the server had answered in a tenth of one. The server keeps working on a cancelled request and caches the
// result, so nothing is lost.
//
// The old page stays mounted until the next one arrives, so a cancelled request never settles (rather than failing): its component
// shows no "canceled" error meanwhile and is unmounted soon after. That's why only a navigation to another path cancels: a page
// that stays mounted (a query change such as ?tab=) keeps its requests.

// Requests the header and the account gate make, which stay mounted across pages
const PERSISTENT = [/^\/api\/account(\?|$)/, /^\/api\/accounts(\?|$)/, /^\/api\/notifications(\?|$)/, /^\/api\/search(\?|$)/];

let controller = new AbortController();
// The path the app shows (notePath), which a link to the same path doesn't leave
let shownPath = typeof window === "undefined" ? "" : window.location.pathname;

const PAGE_ABORT = "page navigation";

const isPersistent = (url: string) => PERSISTENT.some(pattern => pattern.test(url));

// Cancels the current page's requests if the app is about to show another path
export const leavePage = (href: string) => {
    if (typeof window === "undefined") return;
    let target: URL;
    try {
        target = new URL(href, window.location.href);
    } catch {
        return;
    }
    if (target.origin !== window.location.origin || target.pathname === shownPath) return;
    controller.abort(PAGE_ABORT);
    controller = new AbortController();
};

const withPageSignal = (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? "get").toLowerCase();
    if (method !== "get" || !config.url || isPersistent(config.url)) return config;
    const own = config.signal as AbortSignal | undefined;
    // A request with its own signal (a component cancelling a superseded one) is cancelled by either
    config.signal = own && typeof AbortSignal.any === "function" ? AbortSignal.any([own, controller.signal]) : own ?? controller.signal;
    return config;
};

const installed = globalThis as { __pageRequestsInstalled?: boolean };

// Once per page load: the axios interceptors, and a capture-phase listener that sees every in-app link click before Next.js
// handles it (router.push calls leavePage themselves)
export const installPageRequests = () => {
    if (typeof window === "undefined" || installed.__pageRequestsInstalled) return;
    installed.__pageRequestsInstalled = true;
    axios.interceptors.request.use(withPageSignal);
    axios.interceptors.response.use(undefined, error => {
        if (axios.isCancel(error) && (error.config?.signal as AbortSignal | undefined)?.reason === PAGE_ABORT) return new Promise(() => {});
        return Promise.reject(error);
    });
    document.addEventListener("click", event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
        leavePage(link.href);
    }, true);
    // Back and forward: the address has already changed when popstate fires, so compare with the path the app last showed
    window.addEventListener("popstate", () => {
        if (window.location.pathname === shownPath) return;
        controller.abort(PAGE_ABORT);
        controller = new AbortController();
    });
};

// The path the app shows, from usePathname once each navigation has rendered
export const notePath = (pathname: string) => {
    shownPath = pathname;
};
