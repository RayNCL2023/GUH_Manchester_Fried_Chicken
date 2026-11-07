declare module "ggwave" {
	const factory: (module?: { print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<any>;
	export default factory;
}
