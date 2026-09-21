/* List visible QQ X11 windows without reading titles or window contents. */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int ignore_error(Display *display, XErrorEvent *event) {
    (void)display;
    (void)event;
    return 0;
}

static int is_class(Display *display, Window window, const char *wanted) {
    XClassHint hint = {0};
    int match = 0;
    if (XGetClassHint(display, window, &hint)) {
        match = hint.res_class && strcasecmp(hint.res_class, wanted) == 0;
        if (hint.res_name) XFree(hint.res_name);
        if (hint.res_class) XFree(hint.res_class);
    }
    return match;
}

static void scan_tree(Display *display, Window root, Window window, Window main_window,
                      const char *wanted, unsigned int depth) {
    Window returned_root, parent, *children = NULL;
    unsigned int count = 0;
    XWindowAttributes attrs;

    if (window != root && window != main_window && is_class(display, window, wanted) &&
        XGetWindowAttributes(display, window, &attrs) && attrs.width >= 80 && attrs.height >= 60) {
        int root_x = 0, root_y = 0;
        Window child;
        XTranslateCoordinates(display, window, root, 0, 0, &root_x, &root_y, &child);
        printf("{\"id\":\"0x%lx\",\"mapped\":%s,\"depth\":%u,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d}\n",
               window, attrs.map_state == IsViewable ? "true" : "false", depth, root_x, root_y,
               attrs.width, attrs.height);
    }

    if (!XQueryTree(display, window, &returned_root, &parent, &children, &count)) return;
    for (unsigned int i = 0; i < count; i++)
        scan_tree(display, root, children[i], main_window, wanted, depth + 1);
    if (children) XFree(children);
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: list-qq-windows MAIN_WINDOW_ID [WM_CLASS]\n");
        return 2;
    }
    char *end = NULL;
    Window main_window = strtoul(argv[1], &end, 0);
    if (*end || !main_window) return 2;
    const char *wanted = argc == 3 ? argv[2] : "QQ";
    Display *display = XOpenDisplay(NULL);
    if (!display) return 3;
    XSetErrorHandler(ignore_error);
    Window root = DefaultRootWindow(display);
    scan_tree(display, root, root, main_window, wanted, 0);
    XCloseDisplay(display);
    return 0;
}
