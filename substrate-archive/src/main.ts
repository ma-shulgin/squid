import {ResilientRpcClient} from "@subsquid/rpc-client/lib/resilient"
import {readOldTypesBundle} from "@subsquid/substrate-metadata"
import {ServiceManager} from "@subsquid/util-internal-service-manager"
import assert from "assert"
import {Command, InvalidOptionArgumentError} from "commander"
import * as fs from "fs"
import path from "path"
import * as pg from "pg"
import {migrate} from "postgres-migrations"
import {Ingest} from "./ingest"
import {PostgresSink, Sink, WritableSink, DuckDBSink} from "./sink"
import {ProgressTracker, SpeedTracker} from "./util/tracking"
import duckdb from "duckdb"


ServiceManager.run(async sm => {
    let program = new Command()

    program.description('Data dumper for substrate based chains')

    program.option('-e, --endpoint <url...>', 'WS rpc endpoint')
    program.option('--types-bundle <file>', 'JSON file with custom type definitions')
    program.option('--out <sink>', 'Name of a file or postgres connection string')
    program.option('--start-block <number>', 'Height of the block from which to start processing', positiveInteger)

    let options = program.parse().opts() as {
        endpoint: string[]
        out?: string
        typesBundle?: string
        startBlock?: number
    }

    let typesBundle = options.typesBundle == null
        ? undefined
        : readOldTypesBundle(options.typesBundle)

    let startBlock = options.startBlock || 0

    let clients = options.endpoint.map(url => sm.add(new ResilientRpcClient(url)))

    let sink: Sink
    if (options.out) {
        if (options.out.startsWith('postgres://')) {
            let db = new pg.Client({
                connectionString: options.out
            })
            sm.add({
                close() {
                    return db.end()
                }
            })
            await db.connect()
            await migrate({client: db}, path.resolve(__dirname, '../migrations'), {
                logger: msg => console.error(msg)
            })
            let height = await getDbHeight(db)
            startBlock = Math.max(startBlock, height == null ? 0 : height + 1)
            sink = new PostgresSink(db)
        } else {
            // let out = fs.createWriteStream(options.out, {flags: 'a'})
            // sm.add({
            //     close() {
            //         return new Promise((resolve, reject) => {
            //             out.on('error', err => reject(err))
            //             out.on('close', () => resolve())
            //             out.end()
            //         })
            //     }
            // })
            // sink = new WritableSink(out)
            let db = new duckdb.Database(options.out)
            sm.add({
                close() {
                    return exportDuckDbToParquet(db).then(() => {
                        closeDuckDb(db)
                    })
                }
            })
            await migrateDuckDb(db)
            sink = new DuckDBSink(db)
        }
    } else {
        sink = new WritableSink(process.stdout)
    }

    let blockProgress = new ProgressTracker()
    let writeSpeed = new SpeedTracker()
    let lastBlock = startBlock

    sm.every(5000, () => {
        blockProgress.tick()
        console.error(`last block: ${lastBlock}, processing: ${Math.round(blockProgress.speed())} blocks/sec, writing: ${Math.round(writeSpeed.speed())} blocks/sec`)
    })

    let blocks = Ingest.getBlocks({
        clients,
        typesBundle,
        startBlock
    })

    for await (let block of blocks) {
        sm.abort.assertNotAborted()
        writeSpeed.mark()
        await sink.write(block)
        let time = process.hrtime.bigint()
        writeSpeed.inc(1, time)
        blockProgress.inc(1, time)
        lastBlock = block.header.height
        if (lastBlock == 10000) {
            await sm.stop()
        }
    }
})


async function getDbHeight(db: pg.ClientBase): Promise<number | undefined> {
    let res = await db.query("SELECT height FROM block ORDER BY height DESC LIMIT 1")
    if (res.rowCount) {
        return res.rows[0].height
    } else {
        return undefined
    }
}


function urlOptionValidator(protocol?: string[]): (s: string) => string {
    return function (s) {
        let url
        try {
            url = new URL(s)
        } catch(e: any) {
            throw new InvalidOptionArgumentError('invalid url')
        }
        if (protocol && !protocol.includes(url.protocol)) {
            throw new InvalidOptionArgumentError(`invalid protocol, expected ${protocol.join(', ')}`)
        }
        return url.toString()
    }
}


function positiveInteger(s: string): number {
    let n = parseInt(s)
    assert(!isNaN(n) && n >= 0)
    return n
}


async function migrateDuckDb(db: duckdb.Database): Promise<void> {
    return new Promise((resolve, reject) => {
        db.exec(
        `
        CREATE TABLE metadata (
            spec_version integer PRIMARY KEY,
            block_height integer NOT NULL,
            block_hash char(66) NOT NULL,
            hex varchar NOT NULL
        );
        CREATE TABLE block (
            id char(16) PRIMARY KEY,
            height integer NOT NULL,
            hash char(66) NOT NULL,
            parent_hash char(66) NOT NULL,
            timestamp timestamptz NOT NULL
        );
        CREATE TABLE extrinsic (
            id varchar(23) PRIMARY KEY,
            block_id char(16) NOT NULL,
            index_in_block integer NOT NULL,
            name varchar NOT NULL,
            signature varchar,
            success bool not null,
            hash char(66) NOT NULL,
            call_id char(23) NOT NULL
        );
        CREATE TABLE call (
            id char(23) primary key,
            index integer not null,
            extrinsic_id char(23) not null,
            parent_id varchar(23),
            success bool not null,
            name varchar not null,
            args varchar
        );
        CREATE TABLE event (
            id char(23) PRIMARY KEY,
            block_id char(16) not null,
            index_in_block integer NOT NULL,
            phase varchar NOT NULL,
            extrinsic_id char(23),
            call_id char(23),
            name varchar NOT NULL,
            args varchar
        );
        CREATE TABLE warning (
            block_id char(16),
            message varchar
        );
        `,
        (err: any) => {
            err ? reject(err) : resolve()
        })
    })
}


function closeDuckDb(db: duckdb.Database): Promise<void> {
    return new Promise((resolve, reject) => {
        db.close((err: any) => {
            err ? reject(err) : resolve()
        })
    })
}


function exportDuckDbToParquet(db: duckdb.Database): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run("EXPOR DATABASE '10000' (FORMAT PARQUET)", (err) => {
            err ? reject(err) : resolve()
        })
    })
}
