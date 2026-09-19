/* Read-only diagnostic: enumerate QQ/Fcitx windows without reading titles or text. */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <string.h>

static int ignore_xerror(Display *display, XErrorEvent *event) {
    (void)display;
    (void)event;
    return 0;
}

int main(void) {
    Display *display = XOpenDisplay(NULL);
    if (!display) return 1;
    XSetErrorHandler(ignore_xerror);
    Window root = DefaultRootWindow(display), parent, returned_root, *children = NULL;
    unsigned int count = 0;
    if (!XQueryTree(display, root, &returned_root, &parent, &children, &count)) return 2;
    for (unsigned int i = 0; i < count; i++) {
        XClassHint hint = {0};
        if (!XGetClassHint(display, children[i], &hint)) continue;
        const char *name = hint.res_name ? hint.res_name : "";
        const char *class_name = hint.res_class ? hint.res_class : "";
        if (strstr(name, "fcitx") || strstr(class_name, "Fcitx") || strcmp(class_name, "QQ") == 0) {
            XWindowAttributes attrs;
            if (XGetWindowAttributes(display, children[i], &attrs)) {
                printf("id=0x%lx class=%s/%s mapped=%d override=%d geometry=%dx%d+%d+%d\n",
                       children[i], name, class_name, attrs.map_state, attrs.override_redirect,
                       attrs.width, attrs.height, attrs.x, attrs.y);
            }
        }
        if (hint.res_name) XFree(hint.res_name);
        if (hint.res_class) XFree(hint.res_class);
    }
    if (children) XFree(children);
    XCloseDisplay(display);
    return 0;
}
