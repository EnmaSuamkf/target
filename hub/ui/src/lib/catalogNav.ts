/** Top-level views that appear in the header / bottom nav. */
export type NavView = "workflows" | "templates" | "tcps" | "rci" | "settings";

export const NAV_VIEWS: readonly NavView[] = ["workflows", "templates", "tcps", "rci", "settings"];

/** Omits TCP and/or RCI catalog tabs when the corresponding settings flag is off. */
export function filterCatalogNavViews(showTcpCatalog: boolean, showRciCatalog: boolean): readonly NavView[] {
	return NAV_VIEWS.filter((item) => {
		if (item === "tcps") return showTcpCatalog;
		if (item === "rci") return showRciCatalog;
		return true;
	});
}
