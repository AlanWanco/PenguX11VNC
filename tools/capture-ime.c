/* QQ-only Fcitx overlay capture. No input injection, window titles or desktop capture. */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <png.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static int xerror = 0;
static void stop(int signal_number) { (void)signal_number; running = 0; }
static int on_error(Display *d, XErrorEvent *e) { (void)d; (void)e; xerror = 1; return 0; }

static int matches(Display *d, Window w, const char *wanted) {
    XClassHint hint = {0};
    int found = 0;
    if (XGetClassHint(d, w, &hint)) {
        found = hint.res_class && strcmp(hint.res_class, wanted) == 0;
        if (hint.res_name) XFree(hint.res_name);
        if (hint.res_class) XFree(hint.res_class);
    }
    return found;
}

static int focused_on(Display *d, Window qq) {
    Window focus, root, parent, *children;
    int revert;
    unsigned int count;
    XGetInputFocus(d, &focus, &revert);
    for (int depth = 0; depth < 16 && focus > 1; depth++) {
        if (focus == qq) return 1;
        children = NULL;
        if (!XQueryTree(d, focus, &root, &parent, &children, &count)) return 0;
        if (children) XFree(children);
        if (parent == focus) break;
        focus = parent;
    }
    return 0;
}

static Window candidate(Display *d, Window root) {
    Window returned_root, parent, *children = NULL, result = None;
    unsigned int count = 0;
    if (!XQueryTree(d, root, &returned_root, &parent, &children, &count)) return None;
    for (unsigned int i = 0; i < count; i++) {
        XWindowAttributes a;
        if (XGetWindowAttributes(d, children[i], &a) && a.map_state == IsViewable &&
            a.override_redirect && a.depth >= 24 && a.width >= 8 && a.height >= 8 &&
            a.width <= 4096 && a.height <= 2048 && matches(d, children[i], "fcitx")) {
            // Ambiguous multiple popups are not captured to avoid unrelated UI.
            if (result != None) { result = None; break; }
            result = children[i];
        }
    }
    if (children) XFree(children);
    return result;
}

static unsigned char component(unsigned long pixel, unsigned long mask) {
    if (!mask) return 0;
    while (!(mask & 1)) { mask >>= 1; pixel >>= 1; }
    return (unsigned char)(((pixel & mask) * 255) / mask);
}

static void base64(const unsigned char *data, size_t size) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t i = 0; i < size; i += 3) {
        unsigned int value = (unsigned int)data[i] << 16;
        if (i + 1 < size) value |= (unsigned int)data[i + 1] << 8;
        if (i + 2 < size) value |= data[i + 2];
        putchar(alphabet[(value >> 18) & 63]); putchar(alphabet[(value >> 12) & 63]);
        putchar(i + 1 < size ? alphabet[(value >> 6) & 63] : '=');
        putchar(i + 2 < size ? alphabet[value & 63] : '=');
    }
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: capture-ime QQ_WINDOW_ID\n"); return 2; }
    char *end;
    Window qq = strtoul(argv[1], &end, 0);
    if (*end || !qq) return 2;
    Display *d = XOpenDisplay(NULL);
    if (!d) return 3;
    XSetErrorHandler(on_error);
    if (!matches(d, qq, "QQ")) { XCloseDisplay(d); return 4; }
    signal(SIGTERM, stop); signal(SIGINT, stop);
    Window root = DefaultRootWindow(d), child;
    int visible = -1;
    uint64_t previous = 0;
    unsigned int tick = 0;
    while (running) {
        if (++tick % 50 == 0) { puts("{\"heartbeat\":true}"); fflush(stdout); }
        xerror = 0;
        XWindowAttributes qa, ca;
        Window panel = None;
        int qx = 0, qy = 0, cx = 0, cy = 0;
        if (XGetWindowAttributes(d, qq, &qa) && qa.map_state == IsViewable && matches(d, qq, "QQ") && focused_on(d, qq))
            panel = candidate(d, root);
        if (!panel || !XGetWindowAttributes(d, panel, &ca)) goto hidden;
        XTranslateCoordinates(d, qq, root, 0, 0, &qx, &qy, &child);
        XTranslateCoordinates(d, panel, root, 0, 0, &cx, &cy, &child);
        // Reject popups far outside QQ's vicinity rather than capture another application's panel.
        if (cx + ca.width < qx || cx > qx + qa.width || cy + ca.height < qy || cy > qy + qa.height)
            goto hidden;
        XImage *image = XGetImage(d, panel, 0, 0, ca.width, ca.height, AllPlanes, ZPixmap);
        XSync(d, False);
        if (!image || xerror) { if (image) XDestroyImage(image); goto hidden; }
        size_t size = (size_t)ca.width * ca.height * 4;
        unsigned char *rgba = malloc(size);
        if (!rgba) { XDestroyImage(image); goto hidden; }
        uint64_t hash = 1469598103934665603ULL;
        for (int y = 0; y < ca.height; y++) for (int x = 0; x < ca.width; x++) {
            unsigned long pixel = XGetPixel(image, x, y);
            size_t i = ((size_t)y * ca.width + x) * 4;
            // Xwayland can report zero masks for a window visual; use the standard TrueColor layout.
            rgba[i] = component(pixel, image->red_mask ? image->red_mask : 0xff0000);
            rgba[i + 1] = component(pixel, image->green_mask ? image->green_mask : 0xff00);
            rgba[i + 2] = component(pixel, image->blue_mask ? image->blue_mask : 0xff);
            rgba[i + 3] = ca.depth == 32 ? (pixel >> 24) & 255 : 255;
            unsigned int alpha = rgba[i + 3];
            if (alpha && alpha < 255) for (int c = 0; c < 3; c++) {
                unsigned int v = rgba[i + c] * 255 / alpha;
                rgba[i + c] = v > 255 ? 255 : v;
            }
            for (int c = 0; c < 4; c++) hash = (hash ^ rgba[i + c]) * 1099511628211ULL;
        }
        XDestroyImage(image);
        int geometry[] = {cx - qx, cy - qy, ca.width, ca.height, qa.width, qa.height};
        for (unsigned int i = 0; i < sizeof(geometry); i++) hash = (hash ^ ((unsigned char *)geometry)[i]) * 1099511628211ULL;
        if (visible == 1 && hash == previous) { free(rgba); usleep(100000); continue; }
        png_image png = {0};
        png.version = PNG_IMAGE_VERSION; png.width = ca.width; png.height = ca.height; png.format = PNG_FORMAT_RGBA;
        png_alloc_size_t bytes = 0;
        if (!png_image_write_to_memory(&png, NULL, &bytes, 0, rgba, 0, NULL) || bytes > 8 * 1024 * 1024) {
            png_image_free(&png); free(rgba); goto hidden;
        }
        unsigned char *encoded = malloc(bytes);
        if (!encoded || !png_image_write_to_memory(&png, encoded, &bytes, 0, rgba, 0, NULL)) {
            free(encoded); png_image_free(&png); free(rgba); goto hidden;
        }
        printf("{\"visible\":true,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"frameWidth\":%d,\"frameHeight\":%d,\"png\":\"",
            cx - qx, cy - qy, ca.width, ca.height, qa.width, qa.height);
        base64(encoded, bytes); puts("\"}"); fflush(stdout);
        free(encoded); png_image_free(&png); free(rgba);
        previous = hash; visible = 1; usleep(100000); continue;
    hidden:
        if (visible != 0) { puts("{\"visible\":false}"); fflush(stdout); visible = 0; }
        usleep(100000);
    }
    XCloseDisplay(d);
    return 0;
}
