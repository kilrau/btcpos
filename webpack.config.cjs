const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require('path');

module.exports = (env, argv) => ({
    entry: "./bootstrap.ts",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "bootstrap.js",
    },
    mode: argv.mode || "development",
    plugins: [
        new CopyWebpackPlugin({
            patterns: ["index.html", "styles.css",
                "manifest.json", "sw.js",
                "sitemap.xml", "robots.txt",
                { from: "docs", to: "docs" },
                { from: "faq", to: "faq" }]
        })
    ],
    experiments: {
        asyncWebAssembly: true,
        syncWebAssembly: true
    },
    optimization: {
        minimize: argv.mode === "production",
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    devServer: {
        port: 8384,
    },
});

