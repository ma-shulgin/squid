import assert from "assert"
import * as pg from "pg"
import {Block, BlockData, Call, Event, Extrinsic, Metadata, Warning} from "./model"
import {toJSON, toJsonString} from "./util/json"
import WritableStream = NodeJS.WritableStream
import duckdb from "duckdb";


export interface Sink {
    write(block: BlockData): Promise<void>
}


export class PostgresSink implements Sink {
    constructor(private db: pg.ClientBase) {}

    write(block: BlockData): Promise<void> {
        return this.tx(async () => {
            if (block.metadata) {
                await this.saveMetadata(block.metadata)
            }
            await this.saveHeader(block.header)
            await this.saveExtrinsics(block.extrinsics)
            await this.saveCalls(block.calls)
            await this.saveEvents(block.events)
            if (block.warnings?.length) {
                await this.saveWarnings(block.warnings)
            }
        })
    }

    private saveMetadata(metadata: Metadata) {
        return this.db.query(
            "INSERT INTO metadata (spec_version, block_height, block_hash, hex) VALUES ($1, $2, $3, $4)",
            [metadata.spec_version, metadata.block_height, metadata.block_hash, metadata.hex]
        )
    }

    private saveHeader(block: Block) {
        return this.db.query(
            "INSERT INTO block (id, height, hash, parent_hash, timestamp) VALUES ($1, $2, $3, $4, $5)",
            [block.id, block.height, block.hash, block.parent_hash, block.timestamp]
        )
    }

    private saveExtrinsics(extrinsics: Extrinsic[]) {
        return this.insertMany(this.extrinsic_columns, 'extrinsic', extrinsics)
    }

    private extrinsic_columns = {
        id: {cast: 'text'},
        block_id: {cast: 'text'},
        name: {cast: 'text'},
        index_in_block: {cast: 'integer'},
        signature: {map: toJsonString, cast: 'jsonb'},
        success: {cast: 'bool'},
        hash: {cast: 'text', map: toJSON},
        call_id: {cast: 'text'}
    }

    private async saveCalls(calls: Call[]) {
        return this.insertMany(this.call_columns, 'call', calls)
    }

    private call_columns = {
        id: {cast: 'text'},
        index: {cast: 'integer'},
        extrinsic_id: {cast: 'text'},
        name: {cast: 'text'},
        parent_id: {cast: 'text'},
        success: {cast: 'bool'},
        args: {map: toJsonString, cast: 'jsonb'}
    }

    private saveEvents(events: Event[]) {
        return this.insertMany(this.event_columns, 'event', events)
    }

    private event_columns = {
        id: {cast: 'text'},
        block_id: {cast: 'text'},
        phase: {cast: 'text'},
        index_in_block: {cast: 'integer'},
        name: {cast: 'text'},
        extrinsic_id: {cast: 'text'},
        call_id: {cast: 'text'},
        args: {map: toJsonString, cast: 'jsonb'}
    }

    private async saveWarnings(warnings: Warning[]) {
        return this.insertMany(this.warning_columns, 'warning', warnings)
    }

    private warning_columns = {
        block_id: {cast: 'text'},
        message: {cast: 'text'}
    }

    private insertMany<R>(mapping: TableColumns<R>, table: string, rows: R[]) {
        let columns: Record<string, unknown[]> = {}
        for (let name in mapping) {
            columns[name] = new Array(rows.length)
        }
        for (let i = 0; i < rows.length; i++) {
            let row = rows[i]
            for (let name in mapping) {
                let def = mapping[name]
                columns[name][i] = def.map ? def.map(row[name]) : row[name]
            }
        }
        let names = Object.keys(mapping) as (keyof R)[]
        let args = names.map((name, idx) => {
            let param = '$' + (idx + 1)
            let cast = mapping[name].cast
            if (cast) {
                param += '::' + cast + '[]'
            }
            return param
        })
        return this.db.query(
            `INSERT INTO ${table} (${names.join(', ')}) SELECT * FROM unnest(${args.join(', ')}) AS i(${names.join(', ')})`,
            names.map(name => columns[name as string])
        )
    }

    private async tx<T>(cb: () => Promise<T>): Promise<T> {
        await this.db.query('BEGIN')
        try {
            let result = await cb()
            await this.db.query('COMMIT')
            return result
        } catch(e: any) {
            await this.db.query('ROLLBACK').catch(() => {})
            throw e
        }
    }
}


type TableColumns<E> = {
    [name in keyof E]: {map?: (val: E[name]) => unknown, cast?: string}
}


export class WritableSink implements Sink {
    private error?: Error
    private drainHandle?: {resolve: () => void, reject: (err: Error) => void}

    constructor(private writable: WritableStream) {
        this.writable.on('error', this.onError)
        this.writable.on('drain', this.onDrain)
    }

    close(): void {
        this.writable.off('error', this.onError)
        this.writable.off('drain', this.onDrain)
    }

    async write(block: BlockData): Promise<void> {
        if (this.error) throw this.error
        this.writable.write(toJsonString(block))
        let wait = !this.writable.write('\n')
        if (wait) {
            await this.drain()
        }
    }

    private drain(): Promise<void> {
        assert(this.drainHandle == null)
        return new Promise((resolve, reject) => {
            this.drainHandle = {resolve, reject}
        })
    }

    private onDrain = () => {
        if (this.drainHandle) {
            this.drainHandle.resolve()
            this.drainHandle = undefined
        }
    }

    private onError = (err: Error) => {
        this.close()
        this.error = err
        if (this.drainHandle) {
            this.drainHandle.reject(err)
            this.drainHandle = undefined
        }
    }
}


export class DuckDBSink implements Sink {
    constructor(private db: duckdb.Database) {}

    write(block: BlockData): Promise<void> {
        return this.tx(async () => {
            if (block.metadata) {
                await this.saveMetadata(block.metadata)
            }
            await this.saveHeader(block.header)
            await this.saveExtrinsics(block.extrinsics)
            await this.saveCalls(block.calls)
            await this.saveEvents(block.events)
            if (block.warnings?.length) {
                await this.saveWarnings(block.warnings)
            }
        })
    }

    private run(sql: string, ...params: any[]): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, ...params, (err: Error | null) => {
                err ? reject(err) : resolve()
            })
        })
    }

    private saveMetadata(metadata: Metadata): Promise<void> {
        return this.run(
            "INSERT INTO metadata (spec_version, block_height, block_hash, hex) VALUES ($1, $2, $3, $4)",
            metadata.spec_version, metadata.block_height, metadata.block_hash, metadata.hex,
        )
    }

    private saveHeader(block: Block): Promise<void> {
        return this.run(
            "INSERT INTO block (id, height, hash, parent_hash, timestamp) VALUES ($1, $2, $3, $4, $5)",
            block.id, block.height, block.hash, block.parent_hash, block.timestamp,
        )
    }

    private async saveExtrinsics(extrinsics: Extrinsic[]) {
        for (let index = 0; index < extrinsics.length; index++) {
            const extrinsic = extrinsics[index]
            await this.run(
                "INSERT INTO extrinsic (id, block_id, index_in_block, name, signature, success, hash, call_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                extrinsic.id, extrinsic.block_id, extrinsic.index_in_block, extrinsic.name, toJsonString(extrinsic.signature) || null, extrinsic.success, toJSON(extrinsic.hash), extrinsic.call_id,
            );
        }
    }

    private async saveCalls(calls: Call[]) {
        for (let index = 0; index < calls.length; index++) {
            const call = calls[index]
            await this.run(
                "INSERT INTO call (id, index, extrinsic_id, parent_id, success, name, args) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                call.id, call.index, call.extrinsic_id, call.parent_id || null, call.success, call.name, toJsonString(call.args) || null,
            );
        }
    }

    private async saveEvents(events: Event[]) {
        for (let index = 0; index < events.length; index++) {
            const event = events[index]
            await this.run(
                "INSERT INTO event (id, block_id, index_in_block, phase, extrinsic_id, call_id, name, args) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                event.id, event.block_id, event.index_in_block, event.phase, event.extrinsic_id || null, event.call_id || null, event.name, toJsonString(event.args) || null,
            )
        }
    }

    private async saveWarnings(warnings: Warning[]) {
        for (let index = 0; index < warnings.length; index++) {
            const warning = warnings[index]
            await this.run(
                "INSERT INTO warning (block_id, message) VALUES ($1, $2)",
                warning.block_id, warning.message,
            );
        }
    }

    private async tx<T>(cb: () => Promise<T>): Promise<T> {
        await this.run('BEGIN')
        try {
            let result = await cb()
            await this.run('COMMIT')
            return result
        } catch(e: any) {
            await this.run('ROLLBACK').catch(() => {})
            throw e
        }
    }
}
